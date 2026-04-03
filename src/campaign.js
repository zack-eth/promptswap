import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NetwircAPI } from "./api.js";
import { SPLITTERS, applyTemplate } from "./splitters.js";
import { REDUCERS } from "./reducers.js";

const CAMPAIGNS_DIR = join(homedir(), ".promptswap", "campaigns");

function ensureDir() {
  mkdirSync(CAMPAIGNS_DIR, { recursive: true, mode: 0o700 });
}

function campaignPath(id) {
  return join(CAMPAIGNS_DIR, `${id}.json`);
}

function saveCampaign(campaign) {
  ensureDir();
  campaign.updated_at = new Date().toISOString();
  campaign.stats = computeStats(campaign);
  writeFileSync(campaignPath(campaign.id), JSON.stringify(campaign, null, 2) + "\n", { mode: 0o600 });
}

function loadCampaign(id) {
  const path = campaignPath(id);
  if (!existsSync(path)) throw new Error(`Campaign not found: ${id}`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

function computeStats(campaign) {
  const tasks = campaign.tasks;
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const pending = tasks.filter((t) => t.status === "pending");
  const submitted = tasks.filter((t) => t.status === "submitted");
  return {
    total: tasks.length,
    completed: completed.length,
    failed: failed.length,
    pending: pending.length,
    submitted: submitted.length,
    swap_credits_used: campaign.stats?.swap_credits_used || 0,
    spent_cents: campaign.stats?.spent_cents || 0,
    started_at: campaign.stats?.started_at || null,
    elapsed_ms: campaign.stats?.started_at ? Date.now() - new Date(campaign.stats.started_at).getTime() : 0,
  };
}

// --- Public API ---

export function createCampaign(input, config) {
  const splitter = SPLITTERS[config.splitter];
  if (!splitter) throw new Error(`Unknown splitter: ${config.splitter}. Available: ${Object.keys(SPLITTERS).join(", ")}`);
  if (!REDUCERS[config.reducer]) throw new Error(`Unknown reducer: ${config.reducer}. Available: ${Object.keys(REDUCERS).join(", ")}`);

  const chunks = splitter(input, config.splitter_opts || {});
  if (chunks.length === 0) throw new Error("Splitter produced 0 tasks — check your input");

  const tasks = chunks.map((chunk, index) => ({
    index,
    prompt: applyTemplate(config.template, chunk),
    status: "pending",
    job_id: null,
    result: null,
    error: null,
    attempts: 0,
    submitted_at: null,
    completed_at: null,
  }));

  const id = "camp_" + randomBytes(4).toString("hex");
  const campaign = {
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "created",
    config: {
      tag: config.tag || "prompt",
      template: config.template || "{{input}}",
      splitter: config.splitter,
      splitter_opts: config.splitter_opts || {},
      reducer: config.reducer || "concat",
      reducer_opts: config.reducer_opts || {},
      input_file: config.input_file || null,
      swap: config.swap !== false,
      price_cents: config.price_cents || 5,
      seller: config.seller || null,
      max_concurrent: config.max_concurrent || 10,
      max_retries: config.max_retries ?? 2,
      timeout_ms: config.timeout_ms || 120000,
      max_budget_cents: config.max_budget_cents || 0,
      fallback: config.fallback || null,
    },
    tasks,
    stats: {},
  };

  campaign.stats = computeStats(campaign);
  saveCampaign(campaign);

  process.stderr.write(`Campaign ${id}: ${tasks.length} tasks created (${config.splitter} splitter)\n`);
  return campaign;
}

export async function runCampaign(id, serverConfig) {
  const campaign = loadCampaign(id);
  if (campaign.status === "completed") {
    process.stderr.write(`Campaign ${id} is already completed\n`);
    return campaign;
  }

  const api = new NetwircAPI(serverConfig.server, serverConfig.token);
  const cfg = campaign.config;

  // Pre-flight: check seller availability and resolve fallbacks
  const resolvedTag = await resolveTag(api, cfg.tag, cfg.fallback);
  if (resolvedTag !== cfg.tag) {
    process.stderr.write(`No sellers for "${cfg.tag}" — falling back to "${resolvedTag}"\n`);
    cfg.tag = resolvedTag;
  }

  campaign.status = "running";
  if (!campaign.stats.started_at) campaign.stats.started_at = new Date().toISOString();
  saveCampaign(campaign);

  // Re-queue submitted tasks that have no result (stale from previous run)
  for (const task of campaign.tasks) {
    if (task.status === "submitted") {
      // Check if the job actually completed on the server
      try {
        const job = await api.getJob(task.job_id);
        if (job.delivery_body) {
          task.result = job.delivery_body;
          task.status = isErrorResult(job.delivery_body) ? "pending" : "completed";
          task.completed_at = new Date().toISOString();
          if (task.status === "pending") {
            task.attempts++;
            task.error = job.delivery_body;
          }
        } else if (["cancelled", "expired"].includes(job.status)) {
          task.status = "pending";
          task.attempts++;
        }
        // else still in progress — leave as submitted
      } catch {
        task.status = "pending"; // can't reach server for this job, retry
      }
    }
  }

  let paused = false;
  const shutdown = () => {
    paused = true;
    campaign.status = "paused";
    saveCampaign(campaign);
    const s = computeStats(campaign);
    process.stderr.write(`\nPaused: ${s.completed}/${s.total} complete. Resume with: promptswap campaign run ${id}\n`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let consecutiveTimeouts = 0;
  let lastSave = Date.now();

  while (!paused && hasPendingOrSubmitted(campaign)) {
    // Submit new tasks up to concurrency limit
    const inFlight = campaign.tasks.filter((t) => t.status === "submitted").length;
    let toSubmit = cfg.max_concurrent - inFlight;

    while (toSubmit > 0) {
      const task = campaign.tasks.find((t) => t.status === "pending" && t.attempts <= cfg.max_retries);
      if (!task) break;

      // Budget check
      if (cfg.max_budget_cents > 0 && campaign.stats.spent_cents + cfg.price_cents > cfg.max_budget_cents) {
        campaign.status = "paused";
        paused = true;
        process.stderr.write(`\nBudget exceeded ($${(cfg.max_budget_cents / 100).toFixed(2)}). Pausing.\n`);
        break;
      }

      try {
        let job;
        if (cfg.swap) {
          try {
            job = await api.quickJob(cfg.tag, task.prompt, 0, cfg.seller, { swap: true });
          } catch {
            job = await api.quickJob(cfg.tag, task.prompt, cfg.price_cents, cfg.seller);
          }
        } else {
          job = await api.quickJob(cfg.tag, task.prompt, cfg.price_cents, cfg.seller);
        }

        task.job_id = job.id;
        task.status = "submitted";
        task.submitted_at = new Date().toISOString();

        // Check for immediate delivery
        if (job.delivery_body) {
          if (isErrorResult(job.delivery_body)) {
            task.status = "pending";
            task.attempts++;
            task.error = job.delivery_body;
          } else {
            task.status = "completed";
            task.result = job.delivery_body;
            task.completed_at = new Date().toISOString();
            if (job.swap) campaign.stats.swap_credits_used += job.swap_credit_cost || 1;
            else campaign.stats.spent_cents += job.price_cents || cfg.price_cents;
          }
        }
      } catch (err) {
        task.attempts++;
        task.error = err.message;
        if (task.attempts > cfg.max_retries) task.status = "failed";
      }
      toSubmit--;
    }

    // Mark pending tasks that exceeded max_retries as failed
    for (const task of campaign.tasks) {
      if (task.status === "pending" && task.attempts > cfg.max_retries) {
        task.status = "failed";
      }
    }

    // Poll all submitted tasks
    for (const task of campaign.tasks.filter((t) => t.status === "submitted")) {
      try {
        const job = await api.getJob(task.job_id);
        if (job.delivery_body) {
          if (isErrorResult(job.delivery_body)) {
            task.status = "pending";
            task.attempts++;
            task.error = job.delivery_body;
          } else {
            task.status = "completed";
            task.result = job.delivery_body;
            task.completed_at = new Date().toISOString();
            if (job.swap) campaign.stats.swap_credits_used += job.swap_credit_cost || 1;
            else campaign.stats.spent_cents += job.price_cents || cfg.price_cents;
          }
          consecutiveTimeouts = 0;
        } else if (["cancelled", "expired"].includes(job.status)) {
          task.status = "pending";
          task.attempts++;
          consecutiveTimeouts++;
        } else {
          // Check per-task timeout
          const elapsed = Date.now() - new Date(task.submitted_at).getTime();
          if (elapsed > cfg.timeout_ms) {
            task.status = "pending";
            task.attempts++;
            task.error = "timeout";
            consecutiveTimeouts++;
          }
        }
      } catch (err) {
        // Network error polling — leave submitted, will retry next loop
      }
    }

    // Too many consecutive timeouts — pause
    if (consecutiveTimeouts >= 5) {
      campaign.status = "paused";
      paused = true;
      process.stderr.write(`\n5 consecutive timeouts — no sellers available? Pausing.\n`);
      break;
    }

    // Periodic save (every 5s)
    if (Date.now() - lastSave > 5000) {
      saveCampaign(campaign);
      lastSave = Date.now();
    }

    // Progress display
    printProgress(campaign);

    if (hasPendingOrSubmitted(campaign)) await sleep(2000);
  }

  // Final state
  if (!paused) {
    const allDone = campaign.tasks.every((t) => t.status === "completed" || t.status === "failed");
    campaign.status = allDone ? "completed" : "paused";
  }

  saveCampaign(campaign);
  printProgress(campaign, true);

  if (campaign.status === "completed") {
    const failed = campaign.tasks.filter((t) => t.status === "failed").length;
    const s = campaign.stats;
    process.stderr.write(
      `\nDone: ${s.completed}/${s.total} complete` +
        (failed > 0 ? `, ${failed} failed` : "") +
        ` | ${formatMs(s.elapsed_ms)}` +
        (s.swap_credits_used > 0 ? ` | ${s.swap_credits_used} credits` : "") +
        (s.spent_cents > 0 ? ` | $${(s.spent_cents / 100).toFixed(2)}` : "") +
        "\n"
    );
  }

  return campaign;
}

export function campaignStatus(id) {
  const campaign = loadCampaign(id);
  const s = computeStats(campaign);
  console.log(`Campaign: ${campaign.id}`);
  console.log(`Status:   ${campaign.status}`);
  console.log(`Tag:      ${campaign.config.tag}`);
  console.log(`Tasks:    ${s.total} total | ${s.completed} done | ${s.failed} failed | ${s.submitted} in-flight | ${s.pending} pending`);
  if (s.started_at) console.log(`Elapsed:  ${formatMs(s.elapsed_ms)}`);
  if (s.swap_credits_used > 0) console.log(`Credits:  ${s.swap_credits_used}`);
  if (s.spent_cents > 0) console.log(`Spent:    $${(s.spent_cents / 100).toFixed(2)}`);
  console.log(`Created:  ${campaign.created_at}`);
  return campaign;
}

export function campaignResults(id, opts = {}) {
  const campaign = loadCampaign(id);
  const completed = campaign.tasks.filter((t) => t.status === "completed");

  if (completed.length === 0) {
    process.stderr.write(`No completed tasks yet for ${id}\n`);
    return null;
  }

  const reducer = REDUCERS[campaign.config.reducer];
  if (!reducer) throw new Error(`Unknown reducer: ${campaign.config.reducer}`);

  const output = reducer(completed, campaign.config.reducer_opts || {});

  if (opts.output) {
    writeFileSync(opts.output, output + "\n");
    process.stderr.write(`Results written to ${opts.output}\n`);
  } else {
    process.stdout.write(output + "\n");
  }

  return output;
}

export function listCampaigns() {
  ensureDir();
  const files = readdirSync(CAMPAIGNS_DIR).filter((f) => f.startsWith("camp_") && f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No campaigns");
    return [];
  }

  const campaigns = files.map((f) => {
    const c = JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), "utf-8"));
    const s = computeStats(c);
    return { id: c.id, status: c.status, total: s.total, completed: s.completed, failed: s.failed, tag: c.config.tag, created: c.created_at };
  });

  campaigns.sort((a, b) => b.created.localeCompare(a.created));

  for (const c of campaigns) {
    const progress = c.total > 0 ? `${c.completed}/${c.total}` : "0";
    const failStr = c.failed > 0 ? ` (${c.failed} failed)` : "";
    console.log(`${c.id}  ${c.status.padEnd(10)} ${progress.padStart(8)}${failStr}  ${c.tag.padEnd(15)} ${c.created}`);
  }

  return campaigns;
}

export function cancelCampaign(id) {
  const campaign = loadCampaign(id);
  if (campaign.status === "completed") {
    process.stderr.write(`Campaign ${id} is already completed\n`);
    return;
  }
  campaign.status = "failed";
  saveCampaign(campaign);
  process.stderr.write(`Campaign ${id} cancelled\n`);
}

// --- Helpers ---

function hasPendingOrSubmitted(campaign) {
  return campaign.tasks.some((t) => t.status === "pending" || t.status === "submitted");
}

function isErrorResult(result) {
  return typeof result === "string" && result.startsWith("Error:");
}

const DEFAULT_FALLBACK_CHAIN = ["claude-opus", "claude-sonnet", "claude-haiku", "prompt"];

async function resolveTag(api, tag, fallback) {
  // Check if requested tag has sellers
  try {
    const sellers = await api.searchServices(tag);
    if (Array.isArray(sellers) && sellers.length > 0) return tag;
  } catch {
    // search failed — try fallbacks
  }

  // Try explicit fallback list, or default chain
  const chain = fallback || DEFAULT_FALLBACK_CHAIN.filter((t) => t !== tag);
  for (const candidate of chain) {
    try {
      const sellers = await api.searchServices(candidate);
      if (Array.isArray(sellers) && sellers.length > 0) return candidate;
    } catch {
      continue;
    }
  }

  // Nothing available — return original tag and let it fail naturally
  process.stderr.write(`Warning: no sellers found for "${tag}" or any fallback\n`);
  return tag;
}

function printProgress(campaign, final = false) {
  const s = computeStats(campaign);
  const pct = s.total > 0 ? s.completed / s.total : 0;
  const barLen = 30;
  const filled = Math.round(pct * barLen);
  const bar = "#".repeat(filled) + "-".repeat(barLen - filled);
  const elapsed = formatMs(s.elapsed_ms);
  const failStr = s.failed > 0 ? ` | ${s.failed} failed` : "";
  const line = `[${bar}] ${s.completed}/${s.total}${failStr} | ${s.submitted} in-flight | ${elapsed}`;

  if (process.stderr.isTTY && !final) {
    process.stderr.write(`\r\x1b[K${line}`);
  } else if (final) {
    process.stderr.write(`\r\x1b[K${line}\n`);
  }
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
