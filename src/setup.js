import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { save, load } from "./config.js";
import { installHook } from "./hooks.js";

const HOME = homedir();
const NETWIRC_TOKEN_FILE = join(HOME, ".netwirc");
const SKILL_DIR = join(HOME, ".claude", "skills", "use");
const thisDir = dirname(fileURLToPath(import.meta.url));
const skillSource = join(thisDir, "../skills/use/SKILL.md");

export async function setup() {
  console.log("promptswap setup\n");

  // Step 1: netwIRC account
  let token = readToken();
  if (token) {
    console.log("1. netwIRC token found");
  } else {
    console.log("1. No netwIRC token found — let's create one.\n");
    token = await registerOrLogin();
    if (!token) {
      console.error("\nSetup failed: could not get a token.");
      process.exit(1);
    }
  }

  // Verify token works
  try {
    const res = await fetch("https://netwirc.com/api/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = await res.json();
    if (!res.ok) throw new Error(me.error || "Invalid token");
    console.log(`   Logged in as: ${me.username}\n`);
  } catch (err) {
    console.error(`   Token invalid: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Save token to promptswap config
  const config = load();
  config.token = token;
  save(config);
  console.log("2. Token saved to promptswap config");

  // Step 3: Install /use skill
  mkdirSync(SKILL_DIR, { recursive: true });
  cpSync(skillSource, join(SKILL_DIR, "SKILL.md"), { force: true });
  console.log("3. /use skill installed");

  // Step 4: Install rate-limit hook
  installHook();
  console.log(""); // installHook prints its own messages

  // Step 5: Install shell aliases
  installAliases();
  console.log("5. Shell aliases installed (use, earn)");

  console.log("\nSetup complete! You can now:\n");
  console.log("  use ollama 'question'     Run a prompt (free)");
  console.log("  use claude 'question'     Run via Claude sellers");
  console.log("  earn ollama               Sell local capacity for credits");
  console.log("  /use ollama question      In Claude Code");
}

function installAliases() {
  const shell = process.env.SHELL || "/bin/zsh";
  const rcFile = shell.includes("zsh")
    ? join(HOME, ".zshrc")
    : join(HOME, ".bashrc");

  const marker = "# promptswap aliases";
  const aliases = `${marker}
alias use='promptswap use'
alias earn='promptswap earn'
alias host='promptswap host'`;

  try {
    let rc = "";
    try {
      rc = readFileSync(rcFile, "utf-8");
    } catch {
      // file doesn't exist yet
    }

    if (rc.includes(marker)) {
      // Already installed
      return;
    }

    writeFileSync(rcFile, rc + (rc.endsWith("\n") ? "" : "\n") + aliases + "\n");
  } catch (err) {
    console.log(`   Could not write to ${rcFile}: ${err.message}`);
  }
}

async function registerOrLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  const choice = await ask("  Register new account or login? [r/l]: ");

  if (choice.trim().toLowerCase() === "l") {
    const username = await ask("  Username: ");
    const password = await ask("  Password: ");
    rl.close();

    const res = await fetch("https://netwirc.com/api/v1/auth/sign_in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password: password.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`   Login failed: ${data.error || JSON.stringify(data)}`);
      return null;
    }
    const token = data.token;
    saveToken(token);
    return token;
  }

  // Register
  const username = await ask("  Pick a username: ");
  rl.close();

  const password = randomHex(16);
  const res = await fetch("https://netwirc.com/api/v1/auth/sign_up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${username.trim()}@promptswap.netwirc.com`,
      username: username.trim(),
      password,
      password_confirmation: password,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`   Registration failed: ${data.error || data.errors?.join(", ") || JSON.stringify(data)}`);
    return null;
  }

  const token = data.token;
  saveToken(token);

  // Auto-join marketplace room
  try {
    await fetch("https://netwirc.com/api/v1/rooms/marketplace/join", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch {
    // non-critical
  }

  return token;
}

function readToken() {
  try {
    return readFileSync(NETWIRC_TOKEN_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function saveToken(token) {
  writeFileSync(NETWIRC_TOKEN_FILE, token + "\n", { mode: 0o600 });
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}
