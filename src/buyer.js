import { NetwircAPI } from "./api.js";
import { loadSession, saveSession, buildPromptWithContext, addTurn, clearSession } from "./session.js";

export async function run(config, prompt, opts = {}) {
  const api = new NetwircAPI(config.server, config.token);

  const tag = opts.tag || config.tag;
  const priceCents = opts.price_cents || config.price_cents;
  const seller = opts.seller || null;
  const forceSwap = opts.swap === true;
  const forcePaid = opts.paid === true;

  // Session management
  if (opts.new) clearSession();
  const session = loadSession();

  // Build prompt with conversation history
  const fullPrompt = buildPromptWithContext(prompt, session);

  // Check max spend limit
  if (opts.max_spend_cents && priceCents > opts.max_spend_cents) {
    process.stderr.write(
      `Price $${(priceCents / 100).toFixed(2)} exceeds max spend $${(opts.max_spend_cents / 100).toFixed(2)}\n`
    );
    process.exit(1);
  }

  let job;
  let usedSwap = false;

  // Try swap first (free), fall back to paid — unless explicitly forced
  if (!forcePaid) {
    try {
      if (!opts.quiet) process.stderr.write("Submitting swap...");
      job = await api.quickJob(tag, fullPrompt, 0, seller, { swap: true });
      usedSwap = true;
    } catch (e) {
      if (forceSwap) {
        process.stderr.write(`\nSwap failed: ${e.message}\n`);
        process.exit(1);
      }
      // Fall through to paid
    }
  }

  if (!job) {
    if (!opts.quiet) {
      process.stderr.write(
        `Submitting prompt ($${(priceCents / 100).toFixed(2)})...`
      );
    }
    job = await api.quickJob(tag, fullPrompt, priceCents, seller);
  }

  if (!opts.quiet) {
    if (usedSwap) {
      const cost = job.swap_credit_cost || 1;
      const turnInfo = session.turns.length > 0 ? ` (turn ${session.turns.length + 1})` : "";
      process.stderr.write(` swap (${cost} credit${cost > 1 ? "s" : ""}) job #${job.id}${turnInfo}\n`);
    } else {
      process.stderr.write(` paid ($${(job.price_cents / 100).toFixed(2)}) job #${job.id}\n`);
    }
  }

  // Get result
  let result = job.delivery_body;

  if (!result) {
    const timeout = opts.timeout_ms || 120_000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await sleep(2000);
      const updated = await api.getJob(job.id);

      if (updated.delivery_body) {
        result = updated.delivery_body;
        break;
      }

      if (["cancelled", "expired"].includes(updated.status)) {
        process.stderr.write(`\nJob ${updated.status}\n`);
        process.exit(1);
      }
    }
  }

  if (!result) {
    process.stderr.write("\nTimed out waiting for result\n");
    process.exit(1);
  }

  // Save turn to session
  addTurn(session, prompt, result);
  saveSession(session);

  process.stdout.write(result + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
