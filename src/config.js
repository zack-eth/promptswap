import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".promptswap");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TOKEN_FILE = join(homedir(), ".netwirc");

const DEFAULTS = {
  server: "https://netwirc.com",
  tag: "prompt",
  price_cents: 5,
  poll_interval_ms: 3000,
};

export function load() {
  let config;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    config = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    config = { ...DEFAULTS };
  }

  // Token: config file > ~/.netwirc file
  if (!config.token) {
    try {
      config.token = readFileSync(TOKEN_FILE, "utf-8").trim();
    } catch {
      // no token
    }
  }

  return config;
}

export function save(config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function configPath() {
  return CONFIG_FILE;
}
