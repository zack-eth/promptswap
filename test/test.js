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

// ---------------------------------------------------------------------------
// splitters.js — pure logic tests
// ---------------------------------------------------------------------------

import { SPLITTERS, applyTemplate } from "../src/splitters.js";

describe("splitters", () => {
  describe("lines", () => {
    it("splits input by newlines", () => {
      const result = SPLITTERS.lines("a\nb\nc");
      assert.deepEqual(result, ["a", "b", "c"]);
    });

    it("filters empty lines", () => {
      const result = SPLITTERS.lines("a\n\nb\n  \nc");
      assert.deepEqual(result, ["a", "b", "c"]);
    });

    it("handles single line", () => {
      assert.deepEqual(SPLITTERS.lines("hello"), ["hello"]);
    });

    it("returns empty array for empty input", () => {
      assert.deepEqual(SPLITTERS.lines(""), []);
    });
  });

  describe("chunks", () => {
    it("splits into fixed-size chunks", () => {
      const result = SPLITTERS.chunks("abcdefghij", { chunk_size: 4 });
      assert.deepEqual(result, ["abcd", "efgh", "ij"]);
    });

    it("uses default chunk_size of 2000", () => {
      const input = "x".repeat(5000);
      const result = SPLITTERS.chunks(input);
      assert.equal(result.length, 3);
      assert.equal(result[0].length, 2000);
    });

    it("handles overlap", () => {
      const result = SPLITTERS.chunks("abcdefgh", { chunk_size: 4, overlap: 2 });
      // step = 4 - 2 = 2, chunks at 0,2,4,6
      assert.equal(result[0], "abcd");
      assert.equal(result[1], "cdef");
      assert.equal(result[2], "efgh");
    });

    it("handles input shorter than chunk_size", () => {
      const result = SPLITTERS.chunks("hi", { chunk_size: 100 });
      assert.deepEqual(result, ["hi"]);
    });
  });

  describe("json-array", () => {
    it("splits a JSON array of strings", () => {
      const result = SPLITTERS["json-array"](JSON.stringify(["a", "b", "c"]));
      assert.deepEqual(result, ["a", "b", "c"]);
    });

    it("stringifies non-string elements", () => {
      const result = SPLITTERS["json-array"](JSON.stringify([{ x: 1 }, { x: 2 }]));
      assert.deepEqual(result, ['{"x":1}', '{"x":2}']);
    });

    it("throws on non-array input", () => {
      assert.throws(() => SPLITTERS["json-array"]('{"a":1}'), /not a JSON array/);
    });
  });

  describe("csv-rows", () => {
    it("splits CSV with header prepended to each row", () => {
      const input = "name,age\nAlice,30\nBob,25";
      const result = SPLITTERS["csv-rows"](input);
      assert.deepEqual(result, ["name,age\nAlice,30", "name,age\nBob,25"]);
    });

    it("handles single row (just header)", () => {
      const result = SPLITTERS["csv-rows"]("name,age");
      assert.deepEqual(result, []);
    });
  });

  describe("applyTemplate()", () => {
    it("replaces {{input}} with the chunk", () => {
      assert.equal(applyTemplate("Summarize: {{input}}", "hello"), "Summarize: hello");
    });

    it("replaces multiple {{input}} occurrences", () => {
      assert.equal(applyTemplate("A: {{input}} B: {{input}}", "x"), "A: x B: x");
    });

    it("returns chunk when template is null", () => {
      assert.equal(applyTemplate(null, "hello"), "hello");
    });

    it("returns chunk unchanged when no placeholder", () => {
      assert.equal(applyTemplate("no placeholder", "hello"), "no placeholder");
    });
  });
});

// ---------------------------------------------------------------------------
// reducers.js — pure logic tests
// ---------------------------------------------------------------------------

import { REDUCERS } from "../src/reducers.js";

describe("reducers", () => {
  describe("concat", () => {
    it("joins results in index order", () => {
      const results = [
        { index: 2, result: "c" },
        { index: 0, result: "a" },
        { index: 1, result: "b" },
      ];
      assert.equal(REDUCERS.concat(results), "a\nb\nc");
    });

    it("uses custom separator", () => {
      const results = [
        { index: 0, result: "x" },
        { index: 1, result: "y" },
      ];
      assert.equal(REDUCERS.concat(results, { separator: " | " }), "x | y");
    });
  });

  describe("json-array", () => {
    it("collects results into a JSON array", () => {
      const results = [
        { index: 1, result: '{"b":2}' },
        { index: 0, result: '{"a":1}' },
      ];
      const parsed = JSON.parse(REDUCERS["json-array"](results));
      assert.deepEqual(parsed, [{ a: 1 }, { b: 2 }]);
    });

    it("keeps non-JSON results as strings", () => {
      const results = [{ index: 0, result: "plain text" }];
      const parsed = JSON.parse(REDUCERS["json-array"](results));
      assert.deepEqual(parsed, ["plain text"]);
    });
  });

  describe("json-merge", () => {
    it("merges JSON objects in order", () => {
      const results = [
        { index: 0, result: '{"a":1}' },
        { index: 1, result: '{"b":2}' },
      ];
      const parsed = JSON.parse(REDUCERS["json-merge"](results));
      assert.deepEqual(parsed, { a: 1, b: 2 });
    });

    it("later values override earlier ones", () => {
      const results = [
        { index: 0, result: '{"a":1}' },
        { index: 1, result: '{"a":2}' },
      ];
      const parsed = JSON.parse(REDUCERS["json-merge"](results));
      assert.deepEqual(parsed, { a: 2 });
    });

    it("skips non-JSON results", () => {
      const results = [
        { index: 0, result: '{"a":1}' },
        { index: 1, result: "not json" },
      ];
      const parsed = JSON.parse(REDUCERS["json-merge"](results));
      assert.deepEqual(parsed, { a: 1 });
    });
  });

  describe("none", () => {
    it("separates results with boundary marker", () => {
      const results = [
        { index: 0, result: "first" },
        { index: 1, result: "second" },
      ];
      const output = REDUCERS.none(results);
      assert.ok(output.includes("===RESULT_BOUNDARY==="));
      assert.ok(output.startsWith("first"));
      assert.ok(output.endsWith("second"));
    });
  });
});

// ---------------------------------------------------------------------------
// campaign.js — state management tests (no network)
// ---------------------------------------------------------------------------

import { createCampaign } from "../src/campaign.js";

describe("campaign", () => {
  const campaignsDir = join(homedir(), ".promptswap", "campaigns");

  describe("createCampaign()", () => {
    it("creates a campaign with correct task count", () => {
      const campaign = createCampaign("line1\nline2\nline3", {
        splitter: "lines",
        reducer: "concat",
        tag: "prompt",
      });
      assert.equal(campaign.tasks.length, 3);
      assert.equal(campaign.status, "created");
      assert.ok(campaign.id.startsWith("camp_"));
      // Clean up
      try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
    });

    it("applies template to each task", () => {
      const campaign = createCampaign("hello\nworld", {
        splitter: "lines",
        reducer: "concat",
        template: "Say: {{input}}",
        tag: "prompt",
      });
      assert.equal(campaign.tasks[0].prompt, "Say: hello");
      assert.equal(campaign.tasks[1].prompt, "Say: world");
      try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
    });

    it("persists campaign to disk", () => {
      const campaign = createCampaign("a\nb", {
        splitter: "lines",
        reducer: "concat",
        tag: "prompt",
      });
      const path = join(campaignsDir, `${campaign.id}.json`);
      assert.ok(existsSync(path));
      const loaded = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(loaded.id, campaign.id);
      assert.equal(loaded.tasks.length, 2);
      try { rmSync(path); } catch {}
    });

    it("throws on unknown splitter", () => {
      assert.throws(() => createCampaign("x", { splitter: "nope", reducer: "concat" }), /Unknown splitter/);
    });

    it("throws on unknown reducer", () => {
      assert.throws(() => createCampaign("x", { splitter: "lines", reducer: "nope" }), /Unknown reducer/);
    });

    it("throws when splitter produces 0 tasks", () => {
      assert.throws(() => createCampaign("", { splitter: "lines", reducer: "concat" }), /0 tasks/);
    });

    it("all tasks start as pending", () => {
      const campaign = createCampaign("a\nb\nc", {
        splitter: "lines",
        reducer: "concat",
        tag: "prompt",
      });
      for (const task of campaign.tasks) {
        assert.equal(task.status, "pending");
        assert.equal(task.attempts, 0);
        assert.equal(task.job_id, null);
      }
      try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
    });

    it("stores config correctly", () => {
      const campaign = createCampaign("x\ny", {
        splitter: "lines",
        reducer: "json-array",
        tag: "claude-opus",
        max_concurrent: 5,
        max_retries: 3,
        timeout_ms: 60000,
      });
      assert.equal(campaign.config.tag, "claude-opus");
      assert.equal(campaign.config.reducer, "json-array");
      assert.equal(campaign.config.max_concurrent, 5);
      assert.equal(campaign.config.max_retries, 3);
      assert.equal(campaign.config.timeout_ms, 60000);
      try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
    });
  });
});

// ---------------------------------------------------------------------------
// pipeline.js — state management tests (no network)
// ---------------------------------------------------------------------------

import { createPipeline, loadPipeline, cancelPipeline, pipelineResults, listPipelines } from "../src/pipeline.js";

describe("pipeline", () => {
  const pipelinesDir = join(homedir(), ".promptswap", "pipelines");
  const campaignsDir = join(homedir(), ".promptswap", "campaigns");

  describe("createPipeline()", () => {
    it("creates a pipeline with correct stage count", () => {
      const pipeline = createPipeline("a\nb\nc", [
        { splitter: "lines", template: "Summarize: {{input}}", reducer: "concat" },
        { splitter: "chunks", template: "Synthesize: {{input}}", reducer: "concat" },
      ]);
      assert.equal(pipeline.stages.length, 2);
      assert.equal(pipeline.status, "created");
      assert.ok(pipeline.id.startsWith("pipe_"));
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("persists pipeline to disk", () => {
      const pipeline = createPipeline("test input", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      const path = join(pipelinesDir, `${pipeline.id}.json`);
      assert.ok(existsSync(path));
      const loaded = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(loaded.id, pipeline.id);
      assert.equal(loaded.stages.length, 2);
      try { rmSync(path); } catch {}
    });

    it("stores initial input", () => {
      const pipeline = createPipeline("my data here", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      assert.equal(pipeline.initial_input, "my data here");
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("throws with fewer than 2 stages", () => {
      assert.throws(() => createPipeline("x", [
        { splitter: "lines", reducer: "concat" },
      ]), /at least 2 stages/);
    });

    it("throws when stage missing splitter", () => {
      assert.throws(() => createPipeline("x", [
        { reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]), /splitter is required/);
    });

    it("throws when stage missing reducer", () => {
      assert.throws(() => createPipeline("x", [
        { splitter: "lines" },
        { splitter: "lines", reducer: "concat" },
      ]), /reducer is required/);
    });

    it("all stages start as pending", () => {
      const pipeline = createPipeline("data", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "chunks", reducer: "json-array" },
      ]);
      for (const stage of pipeline.stages) {
        assert.equal(stage.status, "pending");
        assert.equal(stage.campaign_id, null);
        assert.equal(stage.output, null);
      }
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("preserves per-stage config", () => {
      const pipeline = createPipeline("data", [
        { splitter: "lines", template: "First: {{input}}", reducer: "concat" },
        { splitter: "chunks", template: "Second: {{input}}", reducer: "json-array", chunk_size: 500 },
      ]);
      assert.equal(pipeline.stages[0].config.template, "First: {{input}}");
      assert.equal(pipeline.stages[1].config.template, "Second: {{input}}");
      assert.equal(pipeline.stages[1].config.splitter, "chunks");
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("inherits global tag and options", () => {
      const pipeline = createPipeline("data", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ], { tag: "claude-opus", max_concurrent: 25 });
      assert.equal(pipeline.tag, "claude-opus");
      assert.equal(pipeline.max_concurrent, 25);
      assert.equal(pipeline.stages[0].config.tag, "claude-opus");
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });
  });

  describe("loadPipeline()", () => {
    it("loads a saved pipeline", () => {
      const pipeline = createPipeline("x\ny", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      const loaded = loadPipeline(pipeline.id);
      assert.equal(loaded.id, pipeline.id);
      assert.equal(loaded.stages.length, 2);
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("throws for non-existent pipeline", () => {
      assert.throws(() => loadPipeline("pipe_nonexistent"), /not found/);
    });
  });

  describe("cancelPipeline()", () => {
    it("sets status to failed", () => {
      const pipeline = createPipeline("x\ny", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      cancelPipeline(pipeline.id);
      const loaded = loadPipeline(pipeline.id);
      assert.equal(loaded.status, "failed");
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });
  });

  describe("pipelineResults()", () => {
    it("returns null when no stages completed", () => {
      const pipeline = createPipeline("data", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      const result = pipelineResults(pipeline.id);
      assert.equal(result, null);
      try { rmSync(join(pipelinesDir, `${pipeline.id}.json`)); } catch {}
    });

    it("returns final_output when pipeline is complete", () => {
      const pipeline = createPipeline("data", [
        { splitter: "lines", reducer: "concat" },
        { splitter: "lines", reducer: "concat" },
      ]);
      // Manually set final_output to simulate completion
      const path = join(pipelinesDir, `${pipeline.id}.json`);
      const p = JSON.parse(readFileSync(path, "utf-8"));
      p.status = "completed";
      p.final_output = "the final answer";
      writeFileSync(path, JSON.stringify(p, null, 2) + "\n");

      const result = pipelineResults(pipeline.id);
      assert.equal(result, "the final answer");
      try { rmSync(path); } catch {}
    });
  });
});

// ---------------------------------------------------------------------------
// verify.js — verification strategy tests
// ---------------------------------------------------------------------------

import { STRATEGIES, DEFAULT_MIN_CONFIDENCE } from "../src/verify.js";

describe("verify", () => {
  describe("majority", () => {
    it("picks the most common result", () => {
      const v = STRATEGIES.majority(["a", "b", "a", "a", "b"]);
      assert.equal(v.result, "a");
      assert.equal(v.agreement, 3);
      assert.equal(v.total, 5);
      assert.equal(v.confidence, 3 / 5);
    });

    it("works with unanimous results", () => {
      const v = STRATEGIES.majority(["x", "x", "x"]);
      assert.equal(v.result, "x");
      assert.equal(v.confidence, 1.0);
    });

    it("picks one when tied", () => {
      const v = STRATEGIES.majority(["a", "b"]);
      assert.ok(["a", "b"].includes(v.result));
      assert.equal(v.confidence, 0.5);
    });

    it("works with single result", () => {
      const v = STRATEGIES.majority(["only"]);
      assert.equal(v.result, "only");
      assert.equal(v.confidence, 1.0);
    });
  });

  describe("consensus", () => {
    it("returns result when all agree", () => {
      const v = STRATEGIES.consensus(["same", "same", "same"]);
      assert.equal(v.result, "same");
      assert.equal(v.confidence, 1.0);
      assert.equal(v.agreement, 3);
    });

    it("returns null when results differ", () => {
      const v = STRATEGIES.consensus(["a", "b", "a"]);
      assert.equal(v.result, null);
      assert.equal(v.confidence, 0);
    });

    it("returns result for single submission", () => {
      const v = STRATEGIES.consensus(["only"]);
      assert.equal(v.result, "only");
      assert.equal(v.confidence, 1.0);
    });
  });

  describe("fuzzy", () => {
    it("matches despite case differences", () => {
      const v = STRATEGIES.fuzzy(["Hello World", "hello world", "HELLO WORLD"]);
      assert.equal(v.confidence, 1.0);
      assert.ok(v.result); // returns one of the originals
    });

    it("matches despite whitespace differences", () => {
      const v = STRATEGIES.fuzzy(["hello  world", "hello world", "hello   world"]);
      assert.equal(v.confidence, 1.0);
    });

    it("matches despite punctuation differences", () => {
      const v = STRATEGIES.fuzzy(["hello, world!", "hello world", "hello world."]);
      assert.equal(v.confidence, 1.0);
    });

    it("distinguishes genuinely different results", () => {
      const v = STRATEGIES.fuzzy(["cats are great", "dogs are great", "cats are great"]);
      assert.equal(v.confidence, 2 / 3);
      assert.ok(v.result.toLowerCase().includes("cats"));
    });
  });

  describe("longest", () => {
    it("picks the longest result", () => {
      const v = STRATEGIES.longest(["short", "medium length", "the longest result here"]);
      assert.equal(v.result, "the longest result here");
    });

    it("confidence is always 1/N", () => {
      const v = STRATEGIES.longest(["a", "bb", "ccc"]);
      assert.equal(v.confidence, 1 / 3);
    });
  });

  describe("DEFAULT_MIN_CONFIDENCE", () => {
    it("is 0.5", () => {
      assert.equal(DEFAULT_MIN_CONFIDENCE, 0.5);
    });
  });
});

// ---------------------------------------------------------------------------
// campaign.js — redundancy config tests
// ---------------------------------------------------------------------------

describe("campaign redundancy", () => {
  const campaignsDir = join(homedir(), ".promptswap", "campaigns");

  it("stores redundancy config", () => {
    const campaign = createCampaign("a\nb", {
      splitter: "lines",
      reducer: "concat",
      tag: "prompt",
      redundancy: 3,
      verify: "consensus",
      min_confidence: 0.8,
    });
    assert.equal(campaign.config.redundancy, 3);
    assert.equal(campaign.config.verify, "consensus");
    assert.equal(campaign.config.min_confidence, 0.8);
    try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
  });

  it("defaults redundancy to 1", () => {
    const campaign = createCampaign("a\nb", {
      splitter: "lines",
      reducer: "concat",
    });
    assert.equal(campaign.config.redundancy, 1);
    try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
  });

  it("tasks have empty submissions array", () => {
    const campaign = createCampaign("a\nb", {
      splitter: "lines",
      reducer: "concat",
      redundancy: 3,
    });
    for (const task of campaign.tasks) {
      assert.ok(Array.isArray(task.submissions));
      assert.equal(task.submissions.length, 0);
      assert.equal(task.verification, null);
    }
    try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
  });

  it("shows redundancy in creation message", () => {
    // Just verify it doesn't crash with redundancy config
    const campaign = createCampaign("x\ny\nz", {
      splitter: "lines",
      reducer: "concat",
      redundancy: 3,
      verify: "fuzzy",
    });
    assert.equal(campaign.tasks.length, 3);
    try { rmSync(join(campaignsDir, `${campaign.id}.json`)); } catch {}
  });
});

// ---------------------------------------------------------------------------
// x402.js — payment protocol tests
// ---------------------------------------------------------------------------

import { buildPaymentRequirements, buildPricingResponse, priceUsdc, extractPayerAddress } from "../src/x402.js";

describe("x402", () => {
  describe("priceUsdc()", () => {
    it("returns correct USDC price for known tags", () => {
      assert.equal(priceUsdc("claude-opus"), 0.025);
      assert.equal(priceUsdc("claude-sonnet"), 0.010);
      assert.equal(priceUsdc("claude-haiku"), 0.003);
      assert.equal(priceUsdc("prompt"), 0.001);
    });

    it("defaults to 0.001 for unknown tags", () => {
      assert.equal(priceUsdc("unknown-tag"), 0.001);
    });
  });

  describe("buildPaymentRequirements()", () => {
    it("returns valid x402 structure", () => {
      const req = buildPaymentRequirements("claude-sonnet", "0xABCD");
      assert.equal(req.x402Version, 1);
      assert.ok(Array.isArray(req.accepts));
      assert.equal(req.accepts.length, 1);
    });

    it("sets correct chain and asset", () => {
      const req = buildPaymentRequirements("prompt", "0x123");
      const accept = req.accepts[0];
      assert.equal(accept.network, "eip155:8453"); // Base
      assert.equal(accept.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // USDC on Base
    });

    it("sets payTo from argument", () => {
      const req = buildPaymentRequirements("prompt", "0xMyWallet");
      assert.equal(req.accepts[0].payTo, "0xMyWallet");
    });

    it("calculates correct amount in USDC base units", () => {
      // claude-sonnet = 10 credits * $0.001 = $0.01 = 10000 units (6 decimals)
      const req = buildPaymentRequirements("claude-sonnet", "0x0");
      assert.equal(req.accepts[0].maxAmountRequired, "10000");

      // claude-opus = 25 credits * $0.001 = $0.025 = 25000 units
      const req2 = buildPaymentRequirements("claude-opus", "0x0");
      assert.equal(req2.accepts[0].maxAmountRequired, "25000");

      // prompt = 1 credit * $0.001 = $0.001 = 1000 units
      const req3 = buildPaymentRequirements("prompt", "0x0");
      assert.equal(req3.accepts[0].maxAmountRequired, "1000");
    });

    it("includes description with tag", () => {
      const req = buildPaymentRequirements("claude-opus", "0x0");
      assert.ok(req.accepts[0].description.includes("claude-opus"));
    });
  });

  describe("buildPricingResponse()", () => {
    it("returns prices for all known tags", () => {
      const resp = buildPricingResponse();
      assert.ok(resp.prices["claude-opus"]);
      assert.ok(resp.prices["claude-sonnet"]);
      assert.ok(resp.prices["prompt"]);
    });

    it("includes chain and asset", () => {
      const resp = buildPricingResponse();
      assert.equal(resp.chain, "eip155:8453");
      assert.ok(resp.asset);
    });

    it("each price has credits, usdc, and usdc_units", () => {
      const resp = buildPricingResponse();
      const opus = resp.prices["claude-opus"];
      assert.equal(opus.credits, 25);
      assert.equal(opus.usdc, 0.025);
      assert.equal(opus.usdc_units, "25000");
    });
  });

  describe("extractPayerAddress()", () => {
    it("extracts address from base64 x402 payload", () => {
      const payload = { payload: { authorization: { from: "0xDEADBEEF" } } };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      assert.equal(extractPayerAddress(encoded), "0xDEADBEEF");
    });

    it("returns 0x0 for invalid input", () => {
      assert.equal(extractPayerAddress("not-valid-base64!!!"), "0x0");
    });

    it("returns 0x0 for empty payload", () => {
      const encoded = Buffer.from("{}").toString("base64");
      assert.equal(extractPayerAddress(encoded), "0x0");
    });
  });
});
