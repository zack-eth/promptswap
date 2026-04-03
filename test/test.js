import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// providers.js — pure‑logic tests (no I/O, no network)
// ---------------------------------------------------------------------------

import { getProvider, allTags } from "../src/providers.js";

describe("providers", () => {
  describe("getProvider()", () => {
    it("maps claude-opus to the claude provider", () => {
      const { name, provider } = getProvider("claude-opus");
      assert.equal(name, "claude");
      assert.ok(provider.tags.includes("claude-opus"));
    });

    it("maps claude-sonnet to the claude provider", () => {
      const { name } = getProvider("claude-sonnet");
      assert.equal(name, "claude");
    });

    it("maps claude-haiku to the claude provider", () => {
      const { name } = getProvider("claude-haiku");
      assert.equal(name, "claude");
    });

    it("maps codex to the codex provider", () => {
      const { name, provider } = getProvider("codex");
      assert.equal(name, "codex");
      assert.ok(provider.tags.includes("codex"));
    });

    it("maps prompt to the ollama provider", () => {
      const { name } = getProvider("prompt");
      assert.equal(name, "ollama");
    });

    it("falls back to ollama for unknown tags", () => {
      const { name } = getProvider("unknown-tag-xyz");
      assert.equal(name, "ollama");
    });

    it("falls back to ollama for empty string tag", () => {
      const { name } = getProvider("");
      assert.equal(name, "ollama");
    });

    it("provider has a modelForTag function", () => {
      const { provider } = getProvider("claude-opus");
      assert.equal(typeof provider.modelForTag, "function");
    });

    it("claude modelForTag returns correct models", () => {
      const { provider } = getProvider("claude-opus");
      assert.equal(provider.modelForTag("claude-opus"), "claude-opus-4-6");
      assert.equal(provider.modelForTag("claude-sonnet"), "claude-sonnet-4-6");
      assert.equal(provider.modelForTag("claude-haiku"), "claude-haiku-4-5-20251001");
    });

    it("claude modelForTag returns null for unknown tag", () => {
      const { provider } = getProvider("claude-opus");
      assert.equal(provider.modelForTag("nope"), null);
    });

    it("codex modelForTag returns null", () => {
      const { provider } = getProvider("codex");
      assert.equal(provider.modelForTag("codex"), null);
    });

    it("ollama modelForTag returns the default model", () => {
      const { provider } = getProvider("prompt");
      const model = provider.modelForTag("prompt");
      assert.equal(typeof model, "string");
      assert.ok(model.length > 0);
    });
  });

  describe("allTags()", () => {
    it("returns an array", () => {
      const tags = allTags();
      assert.ok(Array.isArray(tags));
    });

    it("includes all known tags", () => {
      const tags = allTags();
      for (const expected of [
        "claude-opus",
        "claude-sonnet",
        "claude-haiku",
        "codex",
        "prompt",
      ]) {
        assert.ok(tags.includes(expected), `missing tag: ${expected}`);
      }
    });

    it("returns at least 5 tags", () => {
      assert.ok(allTags().length >= 5);
    });
  });
});

// ---------------------------------------------------------------------------
// session.js — in‑memory logic tests (buildPromptWithContext, addTurn)
//              plus file‑round‑trip tests using a temp directory
// ---------------------------------------------------------------------------

import {
  loadSession,
  saveSession,
  clearSession,
  buildPromptWithContext,
  addTurn,
} from "../src/session.js";

describe("session", () => {
  // ---- Pure logic tests (no filesystem) ----

  describe("buildPromptWithContext()", () => {
    it("returns the prompt unchanged when there are no turns", () => {
      const session = { turns: [] };
      assert.equal(buildPromptWithContext("hello", session), "hello");
    });

    it("includes conversation history when turns exist", () => {
      const session = {
        turns: [{ prompt: "hi", response: "hello there" }],
      };
      const result = buildPromptWithContext("next question", session);
      assert.ok(result.includes("User: hi"));
      assert.ok(result.includes("Assistant: hello there"));
      assert.ok(result.includes("User: next question"));
      assert.ok(result.startsWith("Previous conversation:"));
    });

    it("includes multiple turns in order", () => {
      const session = {
        turns: [
          { prompt: "first", response: "resp1" },
          { prompt: "second", response: "resp2" },
        ],
      };
      const result = buildPromptWithContext("third", session);
      const firstIdx = result.indexOf("User: first");
      const secondIdx = result.indexOf("User: second");
      const thirdIdx = result.indexOf("User: third");
      assert.ok(firstIdx < secondIdx);
      assert.ok(secondIdx < thirdIdx);
    });

    it("trims context when it exceeds MAX_CONTEXT_CHARS (30000)", () => {
      // Create turns with large content that exceed 30000 chars total
      const longText = "x".repeat(5000);
      const session = {
        turns: Array.from({ length: 10 }, (_, i) => ({
          prompt: `prompt${i} ${longText}`,
          response: `response${i} ${longText}`,
        })),
      };
      const originalTurnCount = session.turns.length;
      const result = buildPromptWithContext("final", session);
      // The function should have dropped some earlier turns
      assert.ok(session.turns.length < originalTurnCount);
      // The result should still contain the latest turns
      assert.ok(result.includes("User: final"));
    });

    it("keeps at least one turn even if it exceeds MAX_CONTEXT_CHARS", () => {
      const hugeText = "y".repeat(40000);
      const session = {
        turns: [{ prompt: hugeText, response: hugeText }],
      };
      const result = buildPromptWithContext("q", session);
      // Should still build the prompt even though context is huge
      assert.ok(result.includes("User: q"));
      assert.equal(session.turns.length, 1);
    });
  });

  describe("addTurn()", () => {
    it("adds a turn to the session", () => {
      const session = { turns: [] };
      addTurn(session, "hello", "hi there");
      assert.equal(session.turns.length, 1);
      assert.equal(session.turns[0].prompt, "hello");
      assert.equal(session.turns[0].response, "hi there");
    });

    it("includes a timestamp", () => {
      const session = { turns: [] };
      addTurn(session, "p", "r");
      assert.ok(session.turns[0].timestamp);
      // Should be a valid ISO date string
      assert.ok(!isNaN(Date.parse(session.turns[0].timestamp)));
    });

    it("truncates prompt to 2000 chars", () => {
      const session = { turns: [] };
      const longPrompt = "a".repeat(3000);
      addTurn(session, longPrompt, "resp");
      assert.equal(session.turns[0].prompt.length, 2000);
    });

    it("truncates response to 5000 chars", () => {
      const session = { turns: [] };
      const longResp = "b".repeat(8000);
      addTurn(session, "p", longResp);
      assert.equal(session.turns[0].response.length, 5000);
    });

    it("keeps only the last 10 turns (MAX_TURNS)", () => {
      const session = { turns: [] };
      for (let i = 0; i < 15; i++) {
        addTurn(session, `p${i}`, `r${i}`);
      }
      assert.equal(session.turns.length, 10);
      // The first turn should be p5, not p0
      assert.equal(session.turns[0].prompt, "p5");
      assert.equal(session.turns[9].prompt, "p14");
    });

    it("does not exceed 10 turns when starting with existing turns", () => {
      const session = {
        turns: Array.from({ length: 9 }, (_, i) => ({
          prompt: `existing${i}`,
          response: `resp${i}`,
          timestamp: new Date().toISOString(),
        })),
      };
      addTurn(session, "new1", "resp-new1");
      assert.equal(session.turns.length, 10);
      addTurn(session, "new2", "resp-new2");
      assert.equal(session.turns.length, 10);
      assert.equal(session.turns[9].prompt, "new2");
    });
  });

  // ---- File round‑trip tests ----

  describe("loadSession / saveSession / clearSession (file I/O)", () => {
    // These tests use the real ~/.promptswap/session.json path.
    // We back up and restore any existing file.
    const sessionDir = join(homedir(), ".promptswap");
    const sessionFile = join(sessionDir, "session.json");
    let backup = null;

    before(() => {
      mkdirSync(sessionDir, { recursive: true });
      if (existsSync(sessionFile)) {
        backup = readFileSync(sessionFile);
        rmSync(sessionFile);
      }
    });

    after(() => {
      // Restore original session file
      if (backup !== null) {
        writeFileSync(sessionFile, backup);
      } else if (existsSync(sessionFile)) {
        rmSync(sessionFile);
      }
    });

    beforeEach(() => {
      // Clean slate for each test
      if (existsSync(sessionFile)) rmSync(sessionFile);
    });

    it("loadSession returns empty turns when no file exists", () => {
      const session = loadSession();
      assert.deepEqual(session, { turns: [] });
    });

    it("saveSession then loadSession round-trips", () => {
      const session = {
        turns: [
          { prompt: "hi", response: "hello", timestamp: "2025-01-01T00:00:00Z" },
        ],
      };
      saveSession(session);
      const loaded = loadSession();
      assert.deepEqual(loaded, session);
    });

    it("clearSession removes the file", () => {
      saveSession({ turns: [{ prompt: "x", response: "y", timestamp: "t" }] });
      assert.ok(existsSync(sessionFile));
      clearSession();
      assert.ok(!existsSync(sessionFile));
    });

    it("clearSession does not throw when file is already gone", () => {
      assert.ok(!existsSync(sessionFile));
      assert.doesNotThrow(() => clearSession());
    });
  });
});

// ---------------------------------------------------------------------------
// config.js — file round‑trip tests
// ---------------------------------------------------------------------------

import { load, save, configPath } from "../src/config.js";

describe("config", () => {
  const configDir = join(homedir(), ".promptswap");
  const configFile = join(configDir, "config.json");
  const tokenFile = join(homedir(), ".netwirc");
  let configBackup = null;
  let tokenBackup = null;

  before(() => {
    mkdirSync(configDir, { recursive: true });
    if (existsSync(configFile)) {
      configBackup = readFileSync(configFile);
    }
    if (existsSync(tokenFile)) {
      tokenBackup = readFileSync(tokenFile);
    }
  });

  after(() => {
    // Restore original files
    if (configBackup !== null) {
      writeFileSync(configFile, configBackup);
    } else if (existsSync(configFile)) {
      rmSync(configFile);
    }
    if (tokenBackup !== null) {
      writeFileSync(tokenFile, tokenBackup);
    } else if (existsSync(tokenFile)) {
      // Only remove if we created it during tests (tokenBackup was null)
      // Don't remove — it wasn't ours
    }
  });

  beforeEach(() => {
    // Remove config file for a clean test
    if (existsSync(configFile)) rmSync(configFile);
  });

  describe("load()", () => {
    it("returns defaults when no config file exists", () => {
      // Also temporarily hide the token file
      let tmpTokenBackup = null;
      const tmpPath = tokenFile + ".test-bak";
      if (existsSync(tokenFile)) {
        tmpTokenBackup = readFileSync(tokenFile);
        renameSync(tokenFile, tmpPath);
      }
      try {
        const config = load();
        assert.equal(config.server, "https://netwirc.com");
        assert.equal(config.tag, "prompt");
        assert.equal(config.price_cents, 5);
        assert.equal(config.poll_interval_ms, 3000);
      } finally {
        if (tmpTokenBackup !== null) {
          renameSync(tmpPath, tokenFile);
        }
      }
    });

    it("merges saved config with defaults", () => {
      writeFileSync(configFile, JSON.stringify({ tag: "claude-opus" }));
      // Temporarily hide token file
      const tmpPath = tokenFile + ".test-bak";
      let hadToken = false;
      if (existsSync(tokenFile)) {
        hadToken = true;
        renameSync(tokenFile, tmpPath);
      }
      try {
        const config = load();
        assert.equal(config.tag, "claude-opus");
        // Defaults still present
        assert.equal(config.server, "https://netwirc.com");
        assert.equal(config.price_cents, 5);
      } finally {
        if (hadToken) renameSync(tmpPath, tokenFile);
      }
    });

    it("reads token from config file when present", () => {
      writeFileSync(configFile, JSON.stringify({ token: "tok-from-config" }));
      const config = load();
      assert.equal(config.token, "tok-from-config");
    });

    it("falls back to ~/.netwirc for token", () => {
      // No token in config
      writeFileSync(configFile, JSON.stringify({}));
      // Write a token to ~/.netwirc
      const tmpPath = tokenFile + ".test-bak";
      let hadToken = false;
      if (existsSync(tokenFile)) {
        hadToken = true;
        renameSync(tokenFile, tmpPath);
      }
      writeFileSync(tokenFile, "  tok-from-netwirc  \n");
      try {
        const config = load();
        assert.equal(config.token, "tok-from-netwirc");
      } finally {
        rmSync(tokenFile);
        if (hadToken) renameSync(tmpPath, tokenFile);
      }
    });

    it("prefers config token over ~/.netwirc token", () => {
      writeFileSync(configFile, JSON.stringify({ token: "config-token" }));
      const tmpPath = tokenFile + ".test-bak";
      let hadToken = false;
      if (existsSync(tokenFile)) {
        hadToken = true;
        renameSync(tokenFile, tmpPath);
      }
      writeFileSync(tokenFile, "netwirc-token\n");
      try {
        const config = load();
        assert.equal(config.token, "config-token");
      } finally {
        rmSync(tokenFile);
        if (hadToken) renameSync(tmpPath, tokenFile);
      }
    });
  });

  describe("save()", () => {
    it("creates the config file", () => {
      save({ tag: "codex", server: "https://example.com" });
      assert.ok(existsSync(configFile));
    });

    it("save then load round-trips custom values", () => {
      const data = {
        server: "https://custom.example.com",
        tag: "claude-sonnet",
        price_cents: 10,
        poll_interval_ms: 5000,
        token: "my-token",
      };
      save(data);
      const loaded = load();
      assert.equal(loaded.server, data.server);
      assert.equal(loaded.tag, data.tag);
      assert.equal(loaded.price_cents, data.price_cents);
      assert.equal(loaded.poll_interval_ms, data.poll_interval_ms);
      assert.equal(loaded.token, data.token);
    });

    it("writes valid JSON", () => {
      save({ foo: "bar" });
      const raw = readFileSync(configFile, "utf-8");
      assert.doesNotThrow(() => JSON.parse(raw));
    });
  });

  describe("configPath()", () => {
    it("returns the expected path", () => {
      const p = configPath();
      assert.ok(p.endsWith(".promptswap/config.json"));
      assert.ok(p.startsWith(homedir()));
    });
  });
});
