import { execSync } from "child_process";
import { request } from "http";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
const OLLAMA_DIR = join(homedir(), ".promptswap", "ollama");
const OLLAMA_BIN = join(OLLAMA_DIR, "bin", "ollama");
const OLLAMA_PORT = 11435;
const OLLAMA_URL = `http://localhost:${OLLAMA_PORT}`;
const OLLAMA_ENV = {
  OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
  OLLAMA_MODELS: join(OLLAMA_DIR, "models"),
  HOME: homedir(),
  PATH: process.env.PATH,
};

// Each provider defines how to run a prompt and what tags it supports.
const PROVIDERS = {
  claude: {
    tags: ["claude-opus", "claude-sonnet", "claude-haiku"],
    run(prompt, model) {
      const args = ["-p", shellEscape(prompt), '--allowedTools', '""'];
      if (model) args.push("--model", shellEscape(model));
      return exec(`claude ${args.join(" ")}`);
    },
    modelForTag(tag) {
      const map = {
        "claude-opus": "claude-opus-4-6",
        "claude-sonnet": "claude-sonnet-4-6",
        "claude-haiku": "claude-haiku-4-5-20251001",
      };
      return map[tag] || null;
    },
  },
  ollama: {
    tags: ["prompt"],
    async runAsync(prompt, model) {
      model = model || DEFAULT_OLLAMA_MODEL;
      await ensureOllama(model);
      return ollamaChat(model, prompt);
    },
    run(prompt, model) {
      // Sync fallback — call local ollama via CLI
      model = model || DEFAULT_OLLAMA_MODEL;
      return exec(
        `OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} OLLAMA_MODELS=${shellEscape(join(OLLAMA_DIR, "models"))} ${shellEscape(OLLAMA_BIN)} run ${shellEscape(model)} ${shellEscape(prompt)}`
      );
    },
    modelForTag() {
      return DEFAULT_OLLAMA_MODEL;
    },
  },
  codex: {
    tags: ["codex"],
    run(prompt) {
      return exec(`codex -q ${shellEscape(prompt)}`);
    },
    modelForTag() {
      return null;
    },
  },
};

export function getProvider(tag) {
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    if (provider.tags.includes(tag)) return { name, provider };
  }
  return { name: "ollama", provider: PROVIDERS.ollama };
}

export function allTags() {
  return Object.values(PROVIDERS).flatMap((p) => p.tags);
}

export function runPrompt(prompt, tag) {
  const { provider } = getProvider(tag);
  const model = provider.modelForTag(tag);
  return provider.run(prompt, model);
}

export async function runPromptAsync(prompt, tag) {
  const { provider } = getProvider(tag);
  const model = provider.modelForTag(tag);
  if (provider.runAsync) {
    return provider.runAsync(prompt, model);
  }
  return provider.run(prompt, model);
}

// Flag to trigger model update on next ensureOllama call
let _updateModel = false;
export function setUpdateModel(val) { _updateModel = val; }

// --- Ollama helpers ---

async function ensureOllama(model) {
  // Always use our local install at ~/.promptswap/ollama/
  mkdirSync(join(OLLAMA_DIR, "bin"), { recursive: true });
  mkdirSync(join(OLLAMA_DIR, "models"), { recursive: true });

  // Check if our local Ollama is already running
  const running = await ollamaHealthCheck().catch(() => false);
  if (running) {
    const models = await ollamaListModels();
    const hasModel = models.some((m) => m.name === model || m.name.startsWith(model + ":"));
    if (!hasModel || _updateModel) {
      console.log(_updateModel ? `Updating ${model}...` : `Pulling ${model}...`);
      execSync(`${shellEscape(OLLAMA_BIN)} pull ${shellEscape(model)}`, {
        stdio: "inherit",
        timeout: 600_000,
        env: OLLAMA_ENV,
      });
      _updateModel = false;
    }
    return;
  }

  // Install if our local binary is missing
  if (!existsSync(OLLAMA_BIN)) {
    console.log("Installing Ollama...");
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const url = `https://ollama.com/download/ollama-${platform}-${arch}`;
    execSync(
      `curl -fsSL -o ${shellEscape(OLLAMA_BIN)} ${shellEscape(url)} && chmod +x ${shellEscape(OLLAMA_BIN)}`,
      { stdio: "inherit", timeout: 120_000 }
    );
  }

  // Start our local Ollama on dedicated port
  console.log("Starting Ollama...");
  const { spawn } = await import("child_process");
  const child = spawn(OLLAMA_BIN, ["serve"], {
    stdio: "ignore",
    detached: false,
    env: OLLAMA_ENV,
  });

  // Kill Ollama when this process exits
  const cleanup = () => {
    try { child.kill(); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const up = await ollamaHealthCheck().catch(() => false);
    if (up) break;
  }

  // Pull model
  console.log(`Pulling ${model}... (this may take a few minutes on first run)`);
  execSync(`${shellEscape(OLLAMA_BIN)} pull ${shellEscape(model)}`, {
    stdio: "inherit",
    timeout: 600_000,
    env: OLLAMA_ENV,
  });
}

function ollamaHealthCheck() {
  return new Promise((resolve, reject) => {
    const req = request(`${OLLAMA_URL}/api/tags`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(true));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function ollamaListModels() {
  return new Promise((resolve, reject) => {
    const req = request(`${OLLAMA_URL}/api/tags`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data).models || []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function ollamaChat(model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant. Answer directly and concisely." },
        { role: "user", content: prompt.slice(0, 8000) },
      ],
      stream: false,
    });

    const url = new URL(`${OLLAMA_URL}/api/chat`);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            resolve(result.message?.content?.trim() || "");
          } catch {
            reject(new Error("Invalid response from Ollama"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy();
      reject(new Error("Ollama request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function exec(cmd) {
  const result = execSync(cmd, {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    cwd: "/tmp",
  });
  return result.trim();
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
