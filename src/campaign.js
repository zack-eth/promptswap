import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NetwircAPI } from "./api.js";
import { SPLITTERS, applyTemplate } from "./splitters.js";
import { REDUCERS } from "./reducers.js";
import { STRATEGIES, DEFAULT_MIN_CONFIDENCE } from "./verify.js";

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
  const disputed = tasks.filter((t) => t.status === "disputed");
  return {
    total: tasks.length,
    completed: completed.length,
    failed: failed.length,
    pending: pending.length,
    submitted: submitted.length,
    disputed: disputed.length,
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

  const redundancy = config.redundancy || 1;

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
    // Verification fields (only used when redundancy > 1)
    submissions: [],
    verification: null,
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
      redundancy: config.redundancy || 1,
      verify: config.verify || "majority",
      min_confidence: config.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
    },
    tasks,
    stats: {},
  };

  campaign.stats = computeStats(campaign);
  saveCampaign(campaign);

  const redInfo = redundancy > 1 ? `, ${redundancy}x redundancy, ${config.verify || "majority"} verification` : "";
  process.stderr.write(`Campaign ${id}: ${tasks.length} tasks created (${config.splitter} splitter${redInfo})\n`);
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

  const redundancy = cfg.redundancy || 1;
  const verifyStrategy = STRATEGIES[cfg.verify] || STRATEGIES.majority;

  while (!paused && hasPendingOrSubmitted(campaign)) {
    // Count total in-flight submissions across all tasks
    const totalInFlight = campaign.tasks.reduce((n, t) => {
      return n + (t.submissions || []).filter((s) => s.status === "submitted").length;
    }, 0);
    let slotsAvailable = cfg.max_concurrent - totalInFlight;

    // Submit new submissions for tasks that need them
    for (const task of campaign.tasks) {
      if (slotsAvailable <= 0) break;
      if (task.status === "completed" || task.status === "failed") continue;
      if (task.attempts > cfg.max_retries) { task.status = "failed"; continue; }

      // How many submissions does this task still need?
      if (!task.submissions) task.submissions = [];
      const delivered = task.submissions.filter((s) => s.status === "delivered").length;
      const inFlight = task.submissions.filter((s) => s.status === "submitted").length;
      const needed = redundancy - delivered - inFlight;
      if (needed <= 0) continue;

      // Budget check
      if (cfg.max_budget_cents > 0 && campaign.stats.spent_cents + cfg.price_cents > cfg.max_budget_cents) {
        campaign.status = "paused";
        paused = true;
        process.stderr.write(`\nBudget exceeded ($${(cfg.max_budget_cents / 100).toFixed(2)}). Pausing.\n`);
        break;
      }

      const toSend = Math.min(needed, slotsAvailable);
      for (let s = 0; s < toSend; s++) {
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

          const sub = { job_id: job.id, status: "submitted", result: null, seller: job.seller || null, submitted_at: new Date().toISOString() };

          // Check for immediate delivery
          if (job.delivery_body) {
            if (isErrorResult(job.delivery_body)) {
              sub.status = "failed";
              sub.error = job.delivery_body;
            } else {
              sub.status = "delivered";
              sub.result = job.delivery_body;
              if (job.swap) campaign.stats.swap_credits_used += job.swap_credit_cost || 1;
              else campaign.stats.spent_cents += job.price_cents || cfg.price_cents;
            }
          }

          task.submissions.push(sub);
          task.status = "submitted";
          if (!task.submitted_at) task.submitted_at = new Date().toISOString();
          slotsAvailable--;
        } catch (err) {
          task.attempts++;
          task.error = err.message;
          if (task.attempts > cfg.max_retries) { task.status = "failed"; break; }
        }
      }
    }

    // Poll all in-flight submissions
    for (const task of campaign.tasks) {
      if (task.status !== "submitted") continue;
      if (!task.submissions) continue;

      for (const sub of task.submissions) {
        if (sub.status !== "submitted") continue;
        try {
          const job = await api.getJob(sub.job_id);
          if (job.delivery_body) {
            if (isErrorResult(job.delivery_body)) {
              sub.status = "failed";
              sub.error = job.delivery_body;
            } else {
              sub.status = "delivered";
              sub.result = job.delivery_body;
              if (job.swap) campaign.stats.swap_credits_used += job.swap_credit_cost || 1;
              else campaign.stats.spent_cents += job.price_cents || cfg.price_cents;
            }
            consecutiveTimeouts = 0;
          } else if (["cancelled", "expired"].includes(job.status)) {
            sub.status = "failed";
            sub.error = job.status;
            consecutiveTimeouts++;
          } else {
            const elapsed = Date.now() - new Date(sub.submitted_at).getTime();
            if (elapsed > cfg.timeout_ms) {
              sub.status = "failed";
              sub.error = "timeout";
              consecutiveTimeouts++;
            }
          }
        } catch {
          // Network error — leave submitted, retry next loop
        }
      }
    }

    // Verify tasks that have enough delivered submissions
    for (const task of campaign.tasks) {
      if (task.status !== "submitted") continue;
      if (!task.submissions) continue;

      const delivered = task.submissions.filter((s) => s.status === "delivered");
      const inFlight = task.submissions.filter((s) => s.status === "submitted");
      const failed = task.submissions.filter((s) => s.status === "failed");

      if (redundancy === 1) {
        // No verification needed — single result
        if (delivered.length >= 1) {
          task.result = delivered[0].result;
          task.job_id = delivered[0].job_id;
          task.status = "completed";
          task.completed_at = new Date().toISOString();
        } else if (inFlight.length === 0 && failed.length > 0) {
          // All submissions failed — retry or fail the task
          task.attempts++;
          task.error = failed[0].error;
          task.submissions = [];
          task.status = task.attempts > cfg.max_retries ? "failed" : "pending";
        }
      } else {
        // Redundancy verification
        if (delivered.length >= redundancy) {
          // We have enough — run verification
          const results = delivered.slice(0, redundancy).map((s) => s.result);
          const v = verifyStrategy(results);
          task.verification = v;

          if (v.result !== null && v.confidence >= cfg.min_confidence) {
            task.result = v.result;
            task.job_id = delivered[0].job_id;
            task.status = "completed";
            task.completed_at = new Date().toISOString();
          } else {
            // Verification failed — disputed result
            task.status = "disputed";
            task.error = `Verification failed: ${v.agreement}/${v.total} agree (confidence ${(v.confidence * 100).toFixed(0)}%)`;
          }
        } else if (inFlight.length === 0 && delivered.length + failed.length >= redundancy) {
          // Not enough delivered, no more in flight — some failed
          // Retry failed submissions or accept what we have
          if (delivered.length > 0 && delivered.length >= Math.ceil(redundancy / 2)) {
            // Have a majority — verify with what we got
            const results = delivered.map((s) => s.result);
            const v = verifyStrategy(results);
            task.verification = v;
            if (v.result !== null) {
              task.result = v.result;
              task.job_id = delivered[0].job_id;
              task.status = "completed";
              task.completed_at = new Date().toISOString();
            } else {
              task.status = "disputed";
              task.error = `Partial verification: only ${delivered.length}/${redundancy} delivered`;
            }
          } else {
            // Not enough results — retry
            task.attempts++;
            task.submissions = [];
            task.status = task.attempts > cfg.max_retries ? "failed" : "pending";
          }
        }
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
    const allDone = campaign.tasks.every((t) => ["completed", "failed", "disputed"].includes(t.status));
    campaign.status = allDone ? "completed" : "paused";
  }

  saveCampaign(campaign);
  printProgress(campaign, true);

  if (campaign.status === "completed") {
    const failed = campaign.tasks.filter((t) => t.status === "failed").length;
    const disputed = campaign.tasks.filter((t) => t.status === "disputed").length;
    const s = campaign.stats;
    process.stderr.write(
      `\nDone: ${s.completed}/${s.total} complete` +
        (failed > 0 ? `, ${failed} failed` : "") +
        (disputed > 0 ? `, ${disputed} disputed` : "") +
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
  const parts = [`${s.total} total`, `${s.completed} done`, `${s.failed} failed`, `${s.submitted} in-flight`, `${s.pending} pending`];
  if (s.disputed > 0) parts.push(`${s.disputed} disputed`);
  console.log(`Tasks:    ${parts.join(" | ")}`);
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

function hasActiveWork(campaign) {
  return campaign.tasks.some((t) => ["pending", "submitted"].includes(t.status));
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
  const disputeStr = s.disputed > 0 ? ` | ${s.disputed} disputed` : "";
  const line = `[${bar}] ${s.completed}/${s.total}${failStr}${disputeStr} | ${s.submitted} in-flight | ${elapsed}`;

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
