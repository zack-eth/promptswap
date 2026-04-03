import { NetwircAPI } from "./api.js";
import { connectCable } from "./cable.js";
import { runPrompt, runPromptAsync, setUpdateModel } from "./providers.js";

export async function share(config) {
  const api = new NetwircAPI(config.server, config.token);

  if (config.update_model) setUpdateModel(true);

  const me = await api.me();

  // Register offerings for each tag
  const tags = config.tags || [config.tag];
  for (const tag of tags) {
    await api.registerService(
      tag,
      config.price_cents,
      `Run any prompt (${tag})`,
      { provider: tag },
      { swapCreditPrice: config.swap_credit_price || null }
    );
  }

  if (config.selfOnly) {
    console.log(`Hosting ${tags.join(", ")} as ${me.username}`);
  } else {
    const balance = await api.balance();
    console.log(`Logged in as ${me.username}`);
    console.log(`Balance: $${(balance.balance_cents / 100).toFixed(2)} | Swap credits: ${balance.swap_credits}`);
    for (const tag of tags) {
      console.log(`Offering "${tag}" — earning swap credits`);
    }
  }

  // Pre-warm: run a throwaway prompt to load the model into memory
  const warmupTag = tags[0];
  try {
    process.stdout.write("Warming up model...");
    await runPromptAsync("Say OK", warmupTag);
    process.stdout.write(" ready\n");
  } catch {
    process.stdout.write(" skipped\n");
  }

  const seen = new Set();
  let activeJobs = 0;
  let creditsEarned = 0;
  let jobsCompleted = 0;
  const maxConcurrent = config.max_concurrent || 3;

  const shutdown = async () => {
    console.log("\nShutting down...");
    for (const tag of tags) {
      try {
        await api.removeService(tag);
      } catch {
        // already removed or server down
      }
    }
    console.log(`Session: ${jobsCompleted} jobs, +${creditsEarned} swap credits earned`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const checkJobs = async () => {
    try {
      const jobs = await api.listJobs("seller", "accepted");
      for (const job of jobs) {
        if (seen.has(job.id)) continue;
        if (config.selfOnly && job.buyer !== me.username) {
          seen.add(job.id);
          continue;
        }
        if (activeJobs >= maxConcurrent) {
          console.log(`Job #${job.id}: queued (${activeJobs}/${maxConcurrent} slots busy)`);
          break;
        }
        seen.add(job.id);
        activeJobs++;
        handleJob(api, job, () => {
          activeJobs--;
          jobsCompleted++;
          if (job.swap) creditsEarned += job.swap_credit_cost;
        });
      }
    } catch (err) {
      console.error(`Poll error: ${err.message}`);
    }
  };

  // Try WebSocket for real-time notifications, fall back to polling
  let wsConnected = false;
  try {
    const rooms = await api.request("GET", "/rooms?name=marketplace");
    const marketplaceRoom = Array.isArray(rooms) ? rooms.find((r) => r.name === "marketplace") : null;
    if (!marketplaceRoom) throw new Error("marketplace room not found");
    const cable = await connectCable(config.server, config.token);
    cable.subscribe(marketplaceRoom.id, () => checkJobs());
    wsConnected = true;
    console.log("Listening for jobs (WebSocket)\n");
  } catch (err) {
    console.log(`Listening for jobs (polling every ${config.poll_interval_ms / 1000}s)\n`);
  }

  // Always do an initial check
  await checkJobs();

  // Poll for jobs — WebSocket triggers immediate checks, but poll as fallback
  while (true) {
    await sleep(config.poll_interval_ms);
    await checkJobs();
  }
}

async function handleJob(api, job, onComplete) {
  const prompt = job.description;
  if (!prompt) {
    console.log(`Job #${job.id}: no prompt, skipping`);
    onComplete();
    return;
  }

  const tag = job.tag;
  const self = job.buyer === job.seller;
  const mode = self ? "self" : job.swap ? `swap, ${job.swap_credit_cost} credit${job.swap_credit_cost !== 1 ? 's' : ''}` : `paid, $${(job.price_cents / 100).toFixed(2)}`;
  console.log(`Job #${job.id} [${tag}] from ${job.buyer} (${mode}): "${truncate(prompt, 80)}"`);

  try {
    const result = await runPromptAsync(prompt, tag);
    await api.deliverJob(job.id, result);
    onComplete();
    console.log(`Job #${job.id}: delivered (${result.length} chars)`);
  } catch (err) {
    console.error(`Job #${job.id}: failed — ${err.message}`);
    onComplete();
    try {
      await api.deliverJob(job.id, `Error: prompt execution failed`);
    } catch {
      // delivery failed too
    }
  }
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
