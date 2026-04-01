import { createInterface } from "readline";
import { NetwircAPI } from "./api.js";
import { runPromptAsync, allTags } from "./providers.js";
import { connectCable } from "./cable.js";

export async function repl(config) {
  const api = new NetwircAPI(config.server, config.token);

  const me = await api.me();
  const balance = await api.balance();
  console.log(`Logged in as ${me.username}`);
  console.log(`Balance: $${(balance.balance_cents / 100).toFixed(2)} | Swap credits: ${balance.swap_credits}`);

  const selling = config.sell !== false;
  const tags = config.tags || [config.tag];
  let pollInterval = null;

  if (selling) {
    // Register as seller
    for (const tag of tags) {
      const offering = await api.registerService(
        tag,
        config.price_cents,
        `Run any prompt (${tag})`,
        { provider: tag }
      );
      console.log(`Sharing "${offering.tag}" — earning swap credits from other users`);
    }

    // Background seller
    const seen = new Set();
    let activeJobs = 0;
    const maxConcurrent = config.max_concurrent || 3;

    const checkJobs = async () => {
      try {
        const jobs = await api.listJobs("seller", "accepted");
        for (const job of jobs) {
          if (seen.has(job.id)) continue;
          if (activeJobs >= maxConcurrent) break;
          seen.add(job.id);
          activeJobs++;
          handleSellerJob(api, job, rl).finally(() => activeJobs--);
        }
      } catch {
        // poll error, ignore
      }
    };

    // Try WebSocket, fall back to polling
    let wsConnected = false;
    try {
      const rooms = await api.request("GET", "/rooms?name=marketplace");
      const marketplaceRoom = Array.isArray(rooms)
        ? rooms.find((r) => r.name === "marketplace")
        : null;
      if (marketplaceRoom) {
        const cable = await connectCable(config.server, config.token);
        cable.subscribe(marketplaceRoom.id, () => checkJobs());
        wsConnected = true;
      }
    } catch {
      // WebSocket unavailable
    }

    pollInterval = setInterval(checkJobs, wsConnected ? 30_000 : 3_000);
    await checkJobs();
  }

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\n> ",
  });

  console.log(`\nType a prompt to run it, or a command (/balance, /history, /cost, /help)`);
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      if (input.startsWith("/")) {
        await handleCommand(api, config, input);
      } else {
        await handlePrompt(api, config, input);
      }
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    if (pollInterval) clearInterval(pollInterval);
    console.log("\nShutting down...");
    if (selling) {
      for (const tag of tags) {
        try {
          await api.removeService(tag);
        } catch {
          // already removed
        }
      }
    }
    console.log("Done.");
    process.exit(0);
  });
}

async function handleCommand(api, config, input) {
  const [cmd, ...args] = input.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case "/balance": {
      const b = await api.balance();
      console.log(
        `Balance: $${(b.balance_cents / 100).toFixed(2)} | Swap credits: ${b.swap_credits} (floor: ${b.swap_credit_floor})`
      );
      break;
    }
    case "/history": {
      const history = await api.request("GET", "/wallet/swap_history");
      if (history.length === 0) {
        console.log("No swap history yet.");
      } else {
        for (const t of history) {
          const sign = t.credits > 0 ? "+" : "";
          console.log(
            `  job #${t.job_id} | ${t.tag.padEnd(15)} | ${t.role.padEnd(6)} | ${sign}${t.credits} credits | vs ${t.counterparty}`
          );
        }
      }
      break;
    }
    case "/cost": {
      const tag = args[0] || config.tag;
      const cost = await api.request(
        "GET",
        `/marketplace/swap_cost?tag=${encodeURIComponent(tag)}`
      );
      console.log(`Tag: ${cost.tag}`);
      console.log(
        `Cost: ${cost.swap_credit_cost} credit${cost.swap_credit_cost !== 1 ? "s" : ""}`
      );
      console.log(`Your credits: ${cost.buyer_swap_credits} → ${cost.credits_after} after`);
      console.log(`Status: ${cost.can_swap ? "OK" : "INSUFFICIENT"}`);
      break;
    }
    case "/help":
      console.log(`Commands:
  /balance          Show wallet balance and swap credits
  /history          Show recent swap transactions
  /cost [tag]       Preview swap cost for a tag
  /help             Show this help

Just type a prompt to run it (uses swap credits).
Ctrl+C to quit.`);
      break;
    default:
      console.log(`Unknown command: ${cmd}. Type /help for commands.`);
  }
}

async function handlePrompt(api, config, prompt) {
  const tag = config.tag;

  // Submit swap job
  let job;
  try {
    job = await api.quickJob(tag, prompt, 0, null, { swap: true });
  } catch (err) {
    console.log(`Swap failed: ${err.message}`);
    return;
  }

  // Check for immediate result
  if (job.delivery_body) {
    console.log(`\n${job.delivery_body}`);
    return;
  }

  // Poll
  process.stdout.write("Waiting...");
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const updated = await api.getJob(job.id);
    if (updated.delivery_body) {
      process.stdout.write("\r\x1b[K");
      console.log(`\n${updated.delivery_body}`);
      return;
    }
    if (["cancelled", "expired"].includes(updated.status)) {
      process.stdout.write("\r\x1b[K");
      console.log(`Job ${updated.status}`);
      return;
    }
    process.stdout.write(".");
  }
  process.stdout.write("\r\x1b[K");
  console.log("Timed out.");
}

async function handleSellerJob(api, job, rl) {
  const prompt = job.description;
  if (!prompt) return;

  const mode = job.swap
    ? `swap, ${job.swap_credit_cost} credit${job.swap_credit_cost !== 1 ? "s" : ""}`
    : `paid, $${(job.price_cents / 100).toFixed(2)}`;

  // Print above the prompt line
  process.stdout.write(`\r\x1b[K[Fulfilled job #${job.id} from ${job.buyer} (${mode})]\n`);

  try {
    const result = await runPromptAsync(prompt, job.tag);
    await api.deliverJob(job.id, result);
  } catch (err) {
    console.error(`[job #${job.id}] Error: ${err.message}`);
    try {
      await api.deliverJob(job.id, "An error occurred while processing your request.");
    } catch {
      // delivery failed
    }
  }

  rl.prompt();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
