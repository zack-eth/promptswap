import { spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const RUN_DIR = join(homedir(), ".promptswap");
const PID_FILE = join(RUN_DIR, "daemon.pid");
const LOG_FILE = join(RUN_DIR, "daemon.log");

export function start(args) {
  if (isRunning()) {
    console.log(`Already running (pid ${readPid()})`);
    return;
  }

  mkdirSync(RUN_DIR, { recursive: true });

  const thisFile = fileURLToPath(import.meta.url);
  const bin = join(dirname(thisFile), "../bin/promptswap.js");
  const out = openSync(LOG_FILE, "a");
  const err = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, PROMPTSWAP_DAEMON: "1" },
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Started (pid ${child.pid})`);
  console.log(`Logs: ${LOG_FILE}`);
}

export function stop() {
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped (pid ${pid})`);
  } catch (err) {
    if (err.code === "ESRCH") {
      console.log(`Process ${pid} not found (stale pid file)`);
    } else {
      throw err;
    }
  }

  removePid();
}

export function daemonStatus() {
  const pid = readPid();
  if (!pid) {
    console.log("Daemon: not running");
    return;
  }

  if (isRunning()) {
    console.log(`Daemon: running (pid ${pid})`);
    console.log(`Logs:   ${LOG_FILE}`);
  } else {
    console.log(`Daemon: stale pid file (pid ${pid} not running)`);
    removePid();
  }
}

export function logs(lines = 50) {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file");
    return;
  }
  const content = readFileSync(LOG_FILE, "utf-8");
  const allLines = content.split("\n");
  const tail = allLines.slice(-lines).join("\n");
  process.stdout.write(tail + "\n");
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim());
  } catch {
    return null;
  }
}

function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // already gone
  }
}

function isRunning() {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
