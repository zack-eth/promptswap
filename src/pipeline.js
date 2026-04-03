import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createCampaign, runCampaign } from "./campaign.js";
import { REDUCERS } from "./reducers.js";

const PIPELINES_DIR = join(homedir(), ".promptswap", "pipelines");

function ensureDir() {
  mkdirSync(PIPELINES_DIR, { recursive: true, mode: 0o700 });
}

function pipelinePath(id) {
  return join(PIPELINES_DIR, `${id}.json`);
}

function savePipeline(pipeline) {
  ensureDir();
  pipeline.updated_at = new Date().toISOString();
  writeFileSync(pipelinePath(pipeline.id), JSON.stringify(pipeline, null, 2) + "\n", { mode: 0o600 });
}

function loadPipeline(id) {
  const path = pipelinePath(id);
  if (!existsSync(path)) throw new Error(`Pipeline not found: ${id}`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

export { loadPipeline };

// --- Public API ---

export function createPipeline(input, stages, opts = {}) {
  if (!Array.isArray(stages) || stages.length < 2) {
    throw new Error("Pipeline requires at least 2 stages");
  }

  for (let i = 0; i < stages.length; i++) {
    if (!stages[i].splitter) throw new Error(`Stage ${i + 1}: splitter is required`);
    if (!stages[i].reducer) throw new Error(`Stage ${i + 1}: reducer is required`);
  }

  const id = "pipe_" + randomBytes(4).toString("hex");
  const pipeline = {
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "created",
    input_file: opts.input_file || null,
    tag: opts.tag || "prompt",
    swap: opts.swap !== false,
    price_cents: opts.price_cents || 5,
    seller: opts.seller || null,
    max_concurrent: opts.max_concurrent || 10,
    stages: stages.map((s, i) => ({
      index: i,
      status: "pending",
      config: {
        splitter: s.splitter,
        splitter_opts: s.splitter_opts || { chunk_size: s.chunk_size, overlap: s.overlap },
        template: s.template || "{{input}}",
        reducer: s.reducer,
        reducer_opts: s.reducer_opts || { separator: s.separator },
        tag: s.tag || opts.tag || "prompt",
        max_concurrent: s.max_concurrent || opts.max_concurrent || 10,
        max_retries: s.max_retries ?? 2,
        timeout_ms: s.timeout_ms || 120000,
        fallback: s.fallback || null,
        redundancy: s.redundancy || 1,
        verify: s.verify || "majority",
      },
      campaign_id: null,
      output: null,
    })),
    initial_input: input,
    final_output: null,
  };

  savePipeline(pipeline);
  process.stderr.write(`Pipeline ${id}: ${stages.length} stages created\n`);
  for (let i = 0; i < stages.length; i++) {
    process.stderr.write(`  Stage ${i + 1}: ${stages[i].splitter} → ${stages[i].reducer}\n`);
  }
  return pipeline;
}

export async function runPipeline(id, serverConfig) {
  const pipeline = loadPipeline(id);

  if (pipeline.status === "completed") {
    process.stderr.write(`Pipeline ${id} is already completed\n`);
    return pipeline;
  }

  pipeline.status = "running";
  savePipeline(pipeline);

  let currentInput = pipeline.initial_input;

  // Find where to resume — skip completed stages, use their output
  let startStage = 0;
  for (let i = 0; i < pipeline.stages.length; i++) {
    if (pipeline.stages[i].status === "completed" && pipeline.stages[i].output) {
      currentInput = pipeline.stages[i].output;
      startStage = i + 1;
    } else {
      break;
    }
  }

  if (startStage > 0) {
    process.stderr.write(`Resuming from stage ${startStage + 1}/${pipeline.stages.length}\n`);
  }

  let paused = false;
  const shutdown = () => {
    paused = true;
    pipeline.status = "paused";
    savePipeline(pipeline);
    process.stderr.write(`\nPipeline paused at stage ${startStage + 1}. Resume with: promptswap pipeline run ${id}\n`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (let i = startStage; i < pipeline.stages.length; i++) {
    if (paused) break;

    const stage = pipeline.stages[i];
    const stageNum = i + 1;
    const totalStages = pipeline.stages.length;

    process.stderr.write(`\n--- Stage ${stageNum}/${totalStages}: ${stage.config.splitter} → ${stage.config.reducer} ---\n`);

    stage.status = "running";
    savePipeline(pipeline);

    // Create campaign for this stage
    const campaign = createCampaign(currentInput, {
      ...stage.config,
      tag: stage.config.tag,
      swap: pipeline.swap,
      price_cents: pipeline.price_cents,
      seller: pipeline.seller,
    });

    stage.campaign_id = campaign.id;
    savePipeline(pipeline);

    // Run it
    const result = await runCampaign(campaign.id, serverConfig);

    if (result.status !== "completed") {
      pipeline.status = "paused";
      stage.status = "paused";
      savePipeline(pipeline);
      process.stderr.write(`\nStage ${stageNum} did not complete (${result.status}). Fix and resume with: promptswap pipeline run ${id}\n`);
      return pipeline;
    }

    // Capture the reduced output
    const output = captureOutput(campaign.id);
    stage.output = output;
    stage.status = "completed";
    savePipeline(pipeline);

    process.stderr.write(`Stage ${stageNum} complete — ${output.length} chars output\n`);

    // Feed output as input to next stage
    currentInput = output;
  }

  if (!paused) {
    pipeline.status = "completed";
    pipeline.final_output = currentInput;
    savePipeline(pipeline);

    process.stderr.write(`\nPipeline ${id} complete — ${pipeline.stages.length} stages done\n`);
  }

  return pipeline;
}

export function pipelineStatus(id) {
  const pipeline = loadPipeline(id);
  console.log(`Pipeline: ${pipeline.id}`);
  console.log(`Status:   ${pipeline.status}`);
  console.log(`Stages:   ${pipeline.stages.length}`);
  console.log(`Created:  ${pipeline.created_at}`);
  console.log("");
  for (const stage of pipeline.stages) {
    const campaignInfo = stage.campaign_id ? ` (${stage.campaign_id})` : "";
    const outputInfo = stage.output ? ` — ${stage.output.length} chars` : "";
    console.log(`  Stage ${stage.index + 1}: ${stage.status.padEnd(10)} ${stage.config.splitter} → ${stage.config.reducer}${campaignInfo}${outputInfo}`);
  }
  return pipeline;
}

export function pipelineResults(id, opts = {}) {
  const pipeline = loadPipeline(id);

  // Use final_output if pipeline is complete, otherwise get latest stage output
  let output = pipeline.final_output;
  if (!output) {
    for (let i = pipeline.stages.length - 1; i >= 0; i--) {
      if (pipeline.stages[i].output) {
        output = pipeline.stages[i].output;
        break;
      }
    }
  }

  if (!output) {
    process.stderr.write(`No results yet for pipeline ${id}\n`);
    return null;
  }

  if (opts.output) {
    writeFileSync(opts.output, output + "\n");
    process.stderr.write(`Results written to ${opts.output}\n`);
  } else {
    process.stdout.write(output + "\n");
  }

  return output;
}

export function listPipelines() {
  ensureDir();
  const files = readdirSync(PIPELINES_DIR).filter((f) => f.startsWith("pipe_") && f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No pipelines");
    return [];
  }

  const pipelines = files.map((f) => {
    const p = JSON.parse(readFileSync(join(PIPELINES_DIR, f), "utf-8"));
    const completed = p.stages.filter((s) => s.status === "completed").length;
    return { id: p.id, status: p.status, stages: p.stages.length, completed, created: p.created_at };
  });

  pipelines.sort((a, b) => b.created.localeCompare(a.created));

  for (const p of pipelines) {
    console.log(`${p.id}  ${p.status.padEnd(10)} ${p.completed}/${p.stages} stages  ${p.created}`);
  }

  return pipelines;
}

export function cancelPipeline(id) {
  const pipeline = loadPipeline(id);
  if (pipeline.status === "completed") {
    process.stderr.write(`Pipeline ${id} is already completed\n`);
    return;
  }
  pipeline.status = "failed";
  savePipeline(pipeline);
  process.stderr.write(`Pipeline ${id} cancelled\n`);
}

// --- Helpers ---

function captureOutput(campaignId) {
  const campaignsDir = join(homedir(), ".promptswap", "campaigns");
  const campaign = JSON.parse(readFileSync(join(campaignsDir, `${campaignId}.json`), "utf-8"));
  const completed = campaign.tasks.filter((t) => t.status === "completed");
  const reducer = REDUCERS[campaign.config.reducer];
  return reducer(completed, campaign.config.reducer_opts || {});
}
