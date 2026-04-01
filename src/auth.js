import { readFileSync, writeFileSync } from "fs";
import { randomBytes, randomInt } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { load, save } from "./config.js";

const TOKEN_FILE = join(homedir(), ".netwirc");

const ADJECTIVES = [
  "swift", "bright", "calm", "dark", "eager", "fair", "glad", "keen",
  "bold", "cool", "dry", "fast", "gold", "high", "iron", "jade",
  "kind", "lean", "mild", "neat", "pale", "rare", "sage", "tall",
  "vast", "warm", "wild", "zinc", "blue", "red", "gray", "deep",
];
const NOUNS = [
  "fox", "owl", "elk", "bee", "cod", "eel", "jay", "ram",
  "yak", "bat", "cat", "dog", "ant", "ape", "hen", "hog",
  "lion", "bear", "deer", "duck", "frog", "goat", "hawk", "lynx",
  "mole", "newt", "seal", "slug", "swan", "toad", "wolf", "wren",
];

function randomUsername() {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const num = randomInt(100);
  return `${adj}-${noun}-${num}`;
}

// Get token, auto-registering if needed. Fully non-interactive.
export async function ensureToken() {
  const config = load();
  if (config.token) return config.token;

  const username = randomUsername();
  const password = randomBytes(16).toString("hex");

  const res = await fetch("https://netwirc.com/api/v1/auth/sign_up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, password_confirmation: password }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Registration failed: ${data.error || JSON.stringify(data)}`);
  }

  const token = data.token;

  // Save token
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  config.token = token;
  save(config);

  // Join marketplace
  try {
    await fetch("https://netwirc.com/api/v1/rooms/marketplace/join", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch {}

  console.log(`Registered as ${data.user?.username || username}`);
  return token;
}
