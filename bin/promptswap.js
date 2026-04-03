#!/usr/bin/env node

import { load, save, configPath } from "../src/config.js";
import { share } from "../src/seller.js";
import { run } from "../src/buyer.js";
import { repl } from "../src/repl.js";
import { start, stop, daemonStatus, logs } from "../src/daemon.js";
import { allTags } from "../src/providers.js";
import { setUpdateModel } from "../src/providers.js";
import { installHook, uninstallHook } from "../src/hooks.js";
import { setup } from "../src/setup.js";
import { ensureToken } from "../src/auth.js";
import { startProxy } from "../src/proxy.js";
import { createCampaign, runCampaign, campaignStatus, campaignResults, listCampaigns, cancelCampaign } from "../src/campaign.js";
import { createPipeline, runPipeline, pipelineStatus, pipelineResults, listPipelines, cancelPipeline } from "../src/pipeline.js";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

const MODEL_TAGS = {
  claude: "claude-sonnet",
  "claude-sonnet": "claude-sonnet",
  opus: "claude-opus",
  "claude-opus": "claude-opus",
  haiku: "claude-haiku",
  "claude-haiku": "claude-haiku",
  ollama: "prompt",
  local: "prompt",
  codex: "codex",
};

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "use":
      await cmdUse();
      break;
    case "earn":
      await cmdEarn();
      break;
    case "host":
      await cmdHost();
      break;
    case "setup":
      await setup();
      break;
    case "share":
      await cmdShare();
      break;
    case "start":
      cmdStart();
      break;
    case "stop":
      stop();
      break;
    case "logs":
      logs(parseInt(args[0]) || 50);
      break;
    case "run":
      await cmdRun();
      break;
    case "list":
      await cmdList();
      break;
    case "config":
      cmdConfig();
      break;
    case "status":
      await cmdStatus();
      break;
    case "proxy":
      await cmdProxy();
      break;
    case "connect":
      await cmdConnect();
      break;
    case "campaign":
      await cmdCampaign();
      break;
    case "pipeline":
      await cmdPipeline();
      break;
    case "install-hook":
      installHook();
      break;
    case "uninstall-hook":
      uninstallHook();
      break;
    default:
      usage();
  }
}

// promptswap use <model> [prompt]
async function cmdUse() {
  const model = args[0];
  if (!model) {
    console.error("Usage: promptswap use <model> [prompt]");
    console.error("       promptswap use ollama 'explain monads'");
    console.error("       promptswap use claude                    (interactive REPL)");
    process.exit(1);
  }

  const tag = MODEL_TAGS[model] || model;
  const promptArgs = args.slice(1);
  const flags = parseFlags(promptArgs);
  const positional = promptArgs.filter((a) => !a.startsWith("--") && !isValueOf(promptArgs, a));
  let prompt = positional.join(" ");

  // No prompt + TTY → REPL (buyer only)
  if (!prompt && process.stdin.isTTY) {
    const token = await ensureToken();
    const config = load();
    config.token = token;
    config.tag = tag;
    config.sell = false;
    await repl(config);
    return;
  }

  // Read from stdin if piped
  if (!prompt && !process.stdin.isTTY) {
    prompt = await readStdin();
  }

  if (!prompt) {
    console.error("No prompt provided");
    process.exit(1);
  }

  const token = await ensureToken();
  const config = load();
  config.token = token;
  await run(config, prompt, { ...flags, tag });
}

// promptswap host <model> — only accept your own jobs
async function cmdHost() {
  const model = args[0];
  if (!model) {
    console.error("Usage: promptswap host <model>");
    console.error("       promptswap host opus      (host your own Claude Opus)");
    console.error("       promptswap host ollama     (host your own Ollama)");
    process.exit(1);
  }

  const tag = MODEL_TAGS[model] || model;
  const flags = parseFlags(args.slice(1));

  if (flags.update) setUpdateModel(true);

  const token = await ensureToken();
  const config = load();
  config.token = token;
  config.tag = tag;
  config.tags = [tag];
  config.selfOnly = true;
  if (flags.update) config.update_model = true;

  await share(config);
}

// promptswap earn <model> [--update]
async function cmdEarn() {
  const model = args[0];
  if (!model) {
    console.error("Usage: promptswap earn <model>");
    console.error("       promptswap earn ollama     (sell local capacity)");
    console.error("       promptswap earn claude     (sell Claude capacity)");
    process.exit(1);
  }

  const tag = MODEL_TAGS[model] || model;
  const flags = parseFlags(args.slice(1));

  if (flags.update) setUpdateModel(true);

  const token = await ensureToken();
  const config = load();
  config.token = token;
  config.tag = tag;
  config.tags = [tag];
  if (flags.update) config.update_model = true;

  await share(config);
}

async function cmdShare() {
  const token = await ensureToken();
  const config = load();
  config.token = token;
  const overrides = parseFlags(args);
  const merged = { ...config, ...overrides };

  if (overrides.tags && typeof overrides.tags === "string") {
    merged.tags = overrides.tags.split(",").map((t) => t.trim());
  }

  await share(merged);
}

function cmdStart() {
  requireToken();
  // If first arg is a command (earn, proxy, etc.), pass through; otherwise default to share
  const commands = ["earn", "host", "share", "proxy"];
  if (args[0] && commands.includes(args[0])) {
    start(args);
  } else {
    start(["share", ...args]);
  }
}

async function cmdRun() {
  const token = await ensureToken();
  const config = load();
  config.token = token;
  const flags = parseFlags(args);
  const positional = args.filter((a) => !a.startsWith("--") && !isValueOf(args, a));

  let prompt = positional.join(" ");

  if (!prompt && !process.stdin.isTTY) {
    prompt = await readStdin();
  }

  if (!prompt) {
    console.error("Usage: promptswap run <prompt>");
    process.exit(1);
  }

  await run(config, prompt, flags);
}

function cmdConfig() {
  const config = load();
  const [key, value] = args;

  if (!key) {
    console.log(JSON.stringify(config, null, 2));
    console.log(`\nConfig file: ${configPath()}`);
    return;
  }

  if (!value) {
    console.log(config[key] ?? "(not set)");
    return;
  }

  const noCoerce = new Set(["token", "server", "tag", "model", "tags"]);
  const numVal = Number(value);
  config[key] = Number.isFinite(numVal) && !noCoerce.has(key) ? numVal : value;
  save(config);
  console.log(`${key} = ${config[key]}`);
}

async function cmdList() {
  const token = await ensureToken();
  const config = load();
  config.token = token;
  const { NetwircAPI } = await import("../src/api.js");
  const api = new NetwircAPI(config.server, config.token);
  const flags = parseFlags(args);
  const tag = flags.tag || config.tag;

  const offerings = await api.searchServices(tag);
  if (offerings.length === 0) {
    console.log(`No sellers found for tag "${tag}"`);
    console.log(`\nAvailable tags: ${allTags().join(", ")}`);
    return;
  }

  console.log(`Available sellers for "${tag}":\n`);
  for (const o of offerings) {
    const price = `$${(o.price_cents / 100).toFixed(2)}`;
    const jobs = o.jobs_completed;
    const dispute = o.dispute_rate > 0 ? ` (${o.dispute_rate}% disputes)` : "";
    console.log(`  ${o.username.padEnd(20)} ${price.padEnd(8)} ${jobs} jobs${dispute}`);
  }
}

async function cmdStatus() {
  const token = await ensureToken();
  const config = load();
  config.token = token;
  const { NetwircAPI } = await import("../src/api.js");
  const api = new NetwircAPI(config.server, config.token);

  const me = await api.me();
  const balance = await api.balance();
  console.log(`User:    ${me.username}`);
  console.log(`Balance: $${(balance.balance_cents / 100).toFixed(2)} | Swap credits: ${balance.swap_credits}`);

  daemonStatus();

  try {
    const jobs = await api.listJobs();
    const active = jobs.filter((j) =>
      ["requested", "accepted", "delivered"].includes(j.status)
    );
    if (active.length > 0) {
      console.log(`\nActive jobs:`);
      for (const j of active) {
        const mode = j.swap ? `swap` : `$${(j.price_cents / 100).toFixed(2)}`;
        console.log(
          `  #${j.id} [${j.status}] ${j.tag} (${mode}) ${j.buyer} → ${j.seller || "open"}`
        );
      }
    }
  } catch {
    // jobs endpoint may fail if no jobs
  }
}

async function cmdConnect() {
  const tool = args[0];
  const subArgs = args.slice(1);
  const flags = parseFlags(subArgs);
  const local = subArgs.includes("--local");
  const port = flags.port || 8787;

  const token = await ensureToken();
  const config = load();
  const baseUrl = local
    ? `http://localhost:${port}/v1`
    : `${config.server || "https://netwirc.com"}/api/v1/chat`;
  const apiKey = local ? "local" : token;

  const TOOLS = {
    cursor: {
      name: "Cursor",
      setup() {
        console.log(`Add this in Cursor → Settings → Models → OpenAI-compatible:\n`);
        console.log(`  Base URL:  ${baseUrl}`);
        console.log(`  API Key:   ${apiKey}`);
        console.log(`  Model:     claude-sonnet`);
      },
    },
    continue: {
      name: "Continue",
      setup() {
        const configPath = join(homedir(), ".continue", "config.json");

        let existing = {};
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}

        if (!existing.models) existing.models = [];
        existing.models = existing.models.filter((m) => m.provider !== "openai" || m.apiBase !== baseUrl);
        existing.models.push({
          provider: "openai",
          title: "Claude Sonnet (promptswap)",
          apiBase: baseUrl,
          apiKey,
          model: "claude-sonnet",
        });

        mkdirSync(join(homedir(), ".continue"), { recursive: true });
        writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
        console.log(`Continue configured: ${configPath}`);
      },
    },
    openclaw: {
      name: "OpenClaw",
      setup() {
        const configPath = join(homedir(), ".openclaw", "openclaw.json");

        let existing = {};
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}

        if (!existing.models) existing.models = {};
        if (!existing.models.providers) existing.models.providers = {};
        existing.models.mode = "merge";
        existing.models.providers.promptswap = {
          baseUrl,
          apiKey,
          api: "openai-completions",
          models: [
            { id: "claude-sonnet", name: "Claude Sonnet (promptswap)", reasoning: false, contextWindow: 200000, maxTokens: 16000 },
            { id: "claude-opus", name: "Claude Opus (promptswap)", reasoning: false, contextWindow: 200000, maxTokens: 16000 },
            { id: "claude-haiku", name: "Claude Haiku (promptswap)", reasoning: false, contextWindow: 200000, maxTokens: 16000 },
          ],
        };
        if (!existing.agents) existing.agents = {};
        if (!existing.agents.defaults) existing.agents.defaults = {};
        if (!existing.agents.defaults.models) existing.agents.defaults.models = {};
        existing.agents.defaults.models["promptswap/claude-sonnet"] = {};

        mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
        writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
        console.log(`OpenClaw configured: ${configPath}`);
      },
    },
    python: {
      name: "Python (OpenAI SDK)",
      setup() {
        console.log(`from openai import OpenAI\n`);
        console.log(`client = OpenAI(base_url="${baseUrl}", api_key="${apiKey}")`);
        console.log(`r = client.chat.completions.create(`);
        console.log(`    model="claude-sonnet",`);
        console.log(`    messages=[{"role": "user", "content": "hello"}]`);
        console.log(`)`);
        console.log(`print(r.choices[0].message.content)`);
      },
    },
    curl: {
      name: "curl",
      setup() {
        console.log(`curl -X POST ${baseUrl}/chat/completions \\`);
        console.log(`  -H "Authorization: Bearer ${apiKey}" \\`);
        console.log(`  -H "Content-Type: application/json" \\`);
        console.log(`  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"hello"}]}'`);
      },
    },
  };

  if (!tool || !TOOLS[tool]) {
    console.log(`promptswap connect <tool> [--local] [--port 8787]\n`);
    console.log(`Tools:`);
    for (const [key, t] of Object.entries(TOOLS)) {
      console.log(`  ${key.padEnd(12)} ${t.name}`);
    }
    console.log(`\nExamples:`);
    console.log(`  promptswap connect cursor --local`);
    console.log(`  promptswap connect python`);
    console.log(`  promptswap connect openclaw --local`);
    return;
  }

  console.log(`\n${TOOLS[tool].name} — ${local ? "local proxy" : "marketplace"} (${baseUrl})\n`);
  TOOLS[tool].setup();

  // Auto-start background process
  if (local) {
    console.log("");
    start(["proxy", "--port", String(port)]);
  }
}

async function cmdProxy() {
  const flags = parseFlags(args);
  const port = flags.port || 8787;
  const mode = flags.marketplace ? "marketplace" : flags.local ? "local" : "default";
  const token = await ensureToken();
  const config = load();
  config.token = token;
  startProxy(config, { port, mode });
}

function requireToken() {
  const config = load();
  if (!config.token) {
    console.error("No API token set. Run: promptswap setup");
    process.exit(1);
  }
  return config;
}

const FLAGS_WITH_VALUES = new Set([
  "--price", "--seller", "--tag", "--tags", "--poll",
  "--model", "--max-spend", "--max-concurrent", "--port",
  "--template", "--template-file", "--splitter", "--chunk-size",
  "--overlap", "--reducer", "--separator", "--max-retries",
  "--timeout", "--output", "--max-budget", "--stages",
  "--redundancy", "--verify", "--min-confidence",
]);

function isValueOf(args, arg) {
  const idx = args.indexOf(arg);
  return idx > 0 && FLAGS_WITH_VALUES.has(args[idx - 1]);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--price" && args[i + 1]) {
      flags.price_cents = Math.round(parseFloat(args[++i]) * 100);
    } else if (args[i] === "--seller" && args[i + 1]) {
      flags.seller = args[++i];
    } else if (args[i] === "--tag" && args[i + 1]) {
      flags.tag = args[++i];
    } else if (args[i] === "--tags" && args[i + 1]) {
      flags.tags = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      flags.model = args[++i];
    } else if (args[i] === "--max-spend" && args[i + 1]) {
      flags.max_spend_cents = Math.round(parseFloat(args[++i]) * 100);
    } else if (args[i] === "--max-concurrent" && args[i + 1]) {
      flags.max_concurrent = parseInt(args[++i]);
    } else if (args[i] === "--quiet" || args[i] === "-q") {
      flags.quiet = true;
    } else if (args[i] === "--poll" && args[i + 1]) {
      flags.poll_interval_ms = parseInt(args[++i]) * 1000;
    } else if (args[i] === "--update") {
      flags.update = true;
    } else if (args[i] === "--new") {
      flags.new = true;
    } else if (args[i] === "--port" && args[i + 1]) {
      flags.port = parseInt(args[++i]);
    } else if (args[i] === "--marketplace") {
      flags.marketplace = true;
    } else if (args[i] === "--local") {
      flags.local = true;
    } else if (args[i] === "--template" && args[i + 1]) {
      flags.template = args[++i];
    } else if (args[i] === "--template-file" && args[i + 1]) {
      flags.template_file = args[++i];
    } else if (args[i] === "--splitter" && args[i + 1]) {
      flags.splitter = args[++i];
    } else if (args[i] === "--chunk-size" && args[i + 1]) {
      flags.chunk_size = args[++i];
    } else if (args[i] === "--overlap" && args[i + 1]) {
      flags.overlap = args[++i];
    } else if (args[i] === "--reducer" && args[i + 1]) {
      flags.reducer = args[++i];
    } else if (args[i] === "--separator" && args[i + 1]) {
      flags.separator = args[++i];
    } else if (args[i] === "--max-retries" && args[i + 1]) {
      flags.max_retries = args[++i];
    } else if (args[i] === "--timeout" && args[i + 1]) {
      flags.timeout = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      flags.output = args[++i];
    } else if (args[i] === "--max-budget" && args[i + 1]) {
      flags.max_budget = args[++i];
    } else if (args[i] === "--run") {
      flags.run = true;
    } else if (args[i] === "--paid") {
      flags.paid = true;
    } else if (args[i] === "--stages" && args[i + 1]) {
      flags.stages = args[++i];
    } else if (args[i] === "--redundancy" && args[i + 1]) {
      flags.redundancy = args[++i];
    } else if (args[i] === "--verify" && args[i + 1]) {
      flags.verify = args[++i];
    } else if (args[i] === "--min-confidence" && args[i + 1]) {
      flags.min_confidence = args[++i];
    }
  }
  return flags;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

async function cmdCampaign() {
  const sub = args[0];
  const subArgs = args.slice(1);
  const flags = parseFlags(subArgs);

  switch (sub) {
    case "create": {
      const inputArg = subArgs.find((a) => !a.startsWith("-") && !isValueOf(subArgs, a));
      if (!inputArg) {
        console.error("Usage: promptswap campaign create <input-file> [options]");
        console.error("       Use - for stdin");
        return;
      }

      let input;
      if (inputArg === "-") {
        input = await readStdin();
      } else {
        input = readFileSync(inputArg, "utf-8");
      }

      let template = flags.template || "{{input}}";
      if (flags.template_file) {
        template = readFileSync(flags.template_file, "utf-8").trim();
      }

      const config = {
        tag: flags.tag || load().tag || "prompt",
        template,
        splitter: flags.splitter || "lines",
        splitter_opts: {
          chunk_size: flags.chunk_size ? parseInt(flags.chunk_size) : undefined,
          overlap: flags.overlap ? parseInt(flags.overlap) : undefined,
        },
        reducer: flags.reducer || "concat",
        reducer_opts: {
          separator: flags.separator,
        },
        input_file: inputArg !== "-" ? inputArg : null,
        swap: !flags.paid,
        price_cents: flags.price_cents || load().price_cents || 5,
        seller: flags.seller || null,
        max_concurrent: flags.max_concurrent || 10,
        max_retries: flags.max_retries != null ? parseInt(flags.max_retries) : 2,
        timeout_ms: flags.timeout ? parseInt(flags.timeout) * 1000 : 120000,
        max_budget_cents: flags.max_budget ? Math.round(parseFloat(flags.max_budget) * 100) : 0,
        redundancy: flags.redundancy ? parseInt(flags.redundancy) : 1,
        verify: flags.verify || "majority",
        min_confidence: flags.min_confidence ? parseFloat(flags.min_confidence) : undefined,
      };

      const campaign = createCampaign(input, config);

      if (flags.run) {
        const serverConfig = requireToken();
        await runCampaign(campaign.id, serverConfig);
        campaignResults(campaign.id, { output: flags.output });
      }
      break;
    }

    case "run": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap campaign run <campaign-id>");
        return;
      }
      const serverConfig = requireToken();
      const campaign = await runCampaign(id, serverConfig);
      if (campaign.status === "completed") {
        campaignResults(id, { output: flags.output });
      }
      break;
    }

    case "status": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (id) {
        campaignStatus(id);
      } else {
        listCampaigns();
      }
      break;
    }

    case "results": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap campaign results <campaign-id>");
        return;
      }
      campaignResults(id, { output: flags.output });
      break;
    }

    case "list":
      listCampaigns();
      break;

    case "cancel": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap campaign cancel <campaign-id>");
        return;
      }
      cancelCampaign(id);
      break;
    }

    default:
      console.log(`promptswap campaign <subcommand>

Subcommands:
  create <input-file> [options]   Create a campaign from input data
  run <campaign-id>               Run or resume a campaign
  status [campaign-id]            Show progress (or list all)
  results <campaign-id>           Output aggregated results
  list                            List all campaigns
  cancel <campaign-id>            Cancel a campaign

Options for create:
  --tag <tag>              Model tag (default: prompt)
  --template <string>      Prompt template with {{input}} placeholder
  --template-file <path>   Read template from file
  --splitter <name>        lines | chunks | json-array | csv-rows | file-list
  --chunk-size <n>         For chunks splitter (default: 2000)
  --overlap <n>            For chunks splitter (default: 0)
  --reducer <name>         concat | json-array | json-merge | none
  --separator <string>     For concat reducer (default: \\n)
  --max-concurrent <n>     Parallel jobs (default: 10)
  --max-retries <n>        Retries per task (default: 2)
  --max-budget <dollars>   Max spend in dollars (0 = swap only)
  --timeout <seconds>      Per-task timeout (default: 120)
  --output <path>          Write results to file
  --redundancy <n>         Submit each task to N sellers for verification (default: 1)
  --verify <strategy>      majority | consensus | fuzzy | longest (default: majority)
  --min-confidence <0-1>   Minimum agreement to accept (default: 0.5)
  --run                    Create and immediately run
  --paid                   Use paid credits instead of swap

Examples:
  promptswap campaign create papers.txt --splitter lines \\
    --template "Summarize in 3 bullets:\\n\\n{{input}}" \\
    --reducer json-array --run

  promptswap campaign status camp_a1b2c3d4
  promptswap campaign run camp_a1b2c3d4
  promptswap campaign results camp_a1b2c3d4 --output results.json`);
  }
}

async function cmdPipeline() {
  const sub = args[0];
  const subArgs = args.slice(1);
  const flags = parseFlags(subArgs);

  switch (sub) {
    case "create": {
      const inputArg = subArgs.find((a) => !a.startsWith("-") && !isValueOf(subArgs, a));
      if (!inputArg || !flags.stages) {
        console.error("Usage: promptswap pipeline create <input-file> --stages <stages.json> [options]");
        console.error("       Use - for stdin");
        return;
      }

      let input;
      if (inputArg === "-") {
        input = await readStdin();
      } else {
        input = readFileSync(inputArg, "utf-8");
      }

      const stages = JSON.parse(readFileSync(flags.stages, "utf-8"));

      const pipeline = createPipeline(input, stages, {
        input_file: inputArg !== "-" ? inputArg : null,
        tag: flags.tag || load().tag || "prompt",
        swap: !flags.paid,
        price_cents: flags.price_cents || load().price_cents || 5,
        seller: flags.seller || null,
        max_concurrent: flags.max_concurrent || 10,
      });

      if (flags.run) {
        const serverConfig = requireToken();
        const result = await runPipeline(pipeline.id, serverConfig);
        if (result.status === "completed") {
          pipelineResults(pipeline.id, { output: flags.output });
        }
      }
      break;
    }

    case "run": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap pipeline run <pipeline-id>");
        return;
      }
      const serverConfig = requireToken();
      const result = await runPipeline(id, serverConfig);
      if (result.status === "completed") {
        pipelineResults(id, { output: flags.output });
      }
      break;
    }

    case "status": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (id) {
        pipelineStatus(id);
      } else {
        listPipelines();
      }
      break;
    }

    case "results": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap pipeline results <pipeline-id>");
        return;
      }
      pipelineResults(id, { output: flags.output });
      break;
    }

    case "list":
      listPipelines();
      break;

    case "cancel": {
      const id = subArgs.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: promptswap pipeline cancel <pipeline-id>");
        return;
      }
      cancelPipeline(id);
      break;
    }

    default:
      console.log(`promptswap pipeline <subcommand>

Multi-stage pipelines — chain campaigns where output feeds into the next stage.

Subcommands:
  create <input-file> --stages <stages.json> [options]
  run <pipeline-id>               Run or resume a pipeline
  status [pipeline-id]            Show progress (or list all)
  results <pipeline-id>           Output final results
  list                            List all pipelines
  cancel <pipeline-id>            Cancel a pipeline

Options:
  --stages <path>          JSON file defining pipeline stages (required)
  --tag <tag>              Default model tag for all stages
  --max-concurrent <n>     Default parallel jobs per stage
  --output <path>          Write final results to file
  --run                    Create and immediately run
  --paid                   Use paid credits instead of swap

stages.json format:
  [
    { "splitter": "lines", "template": "Summarize: {{input}}", "reducer": "concat" },
    { "splitter": "chunks", "template": "Synthesize:\\n\\n{{input}}", "reducer": "concat", "chunk_size": 3000 }
  ]

Example:
  promptswap pipeline create papers.txt --stages summarize-pipeline.json --run`);
  }
}

function usage() {
  console.log(`promptswap — trade LLM capacity with swap credits

Commands:
  use <model> [prompt]    Run a prompt (or start interactive REPL)
  host <model>            Host your own capacity (self only, no credits)
  earn <model>            Sell capacity to others, earn swap credits
  setup                   One-time setup (register + install Claude skill)
  status                  Check balance and active jobs
  list [--tag <tag>]      Browse available sellers
  config [key] [value]    View or set configuration
  proxy [--port 8787]     OpenAI-compatible proxy server
                          --local         local CLI only
                          --marketplace   marketplace only
  connect <tool>          Connect a tool (cursor, continue, openclaw, python, curl)
                          --local         use local proxy instead of marketplace
  campaign <sub>          Distributed task orchestration (SETI@Home for LLMs)
                          create, run, status, results, list, cancel
  pipeline <sub>          Multi-stage pipelines — chain campaigns together
                          create, run, status, results, list, cancel

Models:
  ollama                  Local Ollama (free, auto-installs)
  claude                  Claude Sonnet via other users
  opus                    Claude Opus via other users
  haiku                   Claude Haiku via other users
  codex                   Codex via other users

Examples:
  use opus 'explain monads'                 Run a prompt
  use opus 'now in Haskell'                 Continues the conversation
  use opus --new 'something else'           Start fresh session
  host opus                                 Host your own Claude Opus
  earn opus                                 Sell Claude Opus to others
  earn ollama                               Sell local Ollama capacity`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
