import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SESSION_DIR = join(homedir(), ".promptswap");
const SESSION_FILE = join(SESSION_DIR, "session.json");
const MAX_TURNS = 10;
const MAX_CONTEXT_CHARS = 30_000;

export function loadSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return { turns: [] };
  }
}

export function saveSession(session) {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
}

export function clearSession() {
  try {
    unlinkSync(SESSION_FILE);
  } catch {
    // already gone
  }
}

export function buildPromptWithContext(prompt, session) {
  if (session.turns.length === 0) return prompt;

  // Build conversation history
  let context = "";
  for (const turn of session.turns) {
    context += `User: ${turn.prompt}\n\nAssistant: ${turn.response}\n\n`;
  }

  // Trim if too long — keep most recent turns
  while (context.length > MAX_CONTEXT_CHARS && session.turns.length > 1) {
    session.turns.shift();
    context = "";
    for (const turn of session.turns) {
      context += `User: ${turn.prompt}\n\nAssistant: ${turn.response}\n\n`;
    }
  }

  return `Previous conversation:\n\n${context}User: ${prompt}`;
}

export function addTurn(session, prompt, response) {
  session.turns.push({
    prompt: prompt.slice(0, 2000),
    response: response.slice(0, 5000),
    timestamp: new Date().toISOString(),
  });

  // Keep only last N turns
  if (session.turns.length > MAX_TURNS) {
    session.turns = session.turns.slice(-MAX_TURNS);
  }
}
