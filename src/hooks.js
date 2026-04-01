import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const SETTINGS_FILE = join(homedir(), ".claude", "settings.json");

const thisDir = dirname(fileURLToPath(import.meta.url));
const hooksDir = resolve(thisDir, "../hooks");

const HOOKS_CONFIG = {
  StopFailure: [
    {
      matcher: "rate_limit",
      hooks: [
        {
          type: "command",
          command: join(hooksDir, "on-rate-limit.sh"),
          timeout: 5,
        },
      ],
    },
  ],
};

export function installHook() {
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    } catch {
      console.error(`Could not parse ${SETTINGS_FILE}`);
      process.exit(1);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // Merge our hooks without clobbering existing ones
  for (const [event, rules] of Object.entries(HOOKS_CONFIG)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = rules;
    } else {
      // Check if our hooks are already installed
      const existingCommands = settings.hooks[event]
        .flatMap((r) => r.hooks || [])
        .map((h) => h.command);
      for (const rule of rules) {
        const alreadyInstalled = rule.hooks.every((h) =>
          existingCommands.includes(h.command)
        );
        if (!alreadyInstalled) {
          settings.hooks[event].push(rule);
        }
      }
    }
  }

  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  console.log("Hooks installed in ~/.claude/settings.json");
  console.log("");
  console.log("When you hit a rate limit, type /continue to re-run your");
  console.log("prompt through promptswap automatically.");
}

export function uninstallHook() {
  if (!existsSync(SETTINGS_FILE)) {
    console.log("No settings file found");
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    console.error(`Could not parse ${SETTINGS_FILE}`);
    process.exit(1);
  }

  if (!settings.hooks) {
    console.log("No hooks configured");
    return;
  }

  let removed = false;
  for (const [event, rules] of Object.entries(HOOKS_CONFIG)) {
    if (!settings.hooks[event]) continue;
    const ourCommands = rules.flatMap((r) => r.hooks || []).map((h) => h.command);
    settings.hooks[event] = settings.hooks[event].filter((rule) => {
      const isOurs = (rule.hooks || []).some((h) => ourCommands.includes(h.command));
      if (isOurs) removed = true;
      return !isOurs;
    });
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  console.log(removed ? "Hooks removed" : "No promptswap hooks found");
}
