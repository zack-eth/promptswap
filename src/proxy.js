import { createServer } from "http";
import { randomBytes } from "crypto";
import { runPromptAsync } from "./providers.js";
import { NetwircAPI } from "./api.js";
import { buildPaymentRequirements, buildPricingResponse, verifyAndSettle } from "./x402.js";

const MODEL_MAP = {
  // OpenAI-style names
  "claude-opus-4-6": "claude-opus",
  "claude-sonnet-4-6": "claude-sonnet",
  "claude-haiku-4-5-20251001": "claude-haiku",
  // Claude names
  "claude-opus": "claude-opus",
  "claude-sonnet": "claude-sonnet",
  "claude-haiku": "claude-haiku",
  // Short aliases
  opus: "claude-opus",
  sonnet: "claude-sonnet",
  haiku: "claude-haiku",
  // OpenAI aliases (map to Claude equivalents)
  "gpt-4": "claude-sonnet",
  "gpt-4o": "claude-sonnet",
  "gpt-4o-mini": "claude-haiku",
  "gpt-3.5-turbo": "claude-haiku",
};

const MODELS = Object.keys(MODEL_MAP);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
};

export function startProxy(config, { port = 8787, mode = "default" } = {}) {
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    const headers = { "Content-Type": "application/json", ...CORS };

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ status: "ok" }));
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      const data = MODELS.map((id) => ({ id, object: "model", owned_by: "promptswap" }));
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ object: "list", data }));
    }

    // x402 pricing discovery — public, no auth
    if (req.method === "GET" && req.url?.startsWith("/v1/x402/price")) {
      res.writeHead(200, headers);
      return res.end(JSON.stringify(buildPricingResponse()));
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const hasAuth = req.headers.authorization && req.headers.authorization !== "Bearer local";
      const hasPayment = !!req.headers["x-payment"];
      const x402Wallet = config.x402_wallet;

      // x402 gate: if enabled, no auth, and no payment → return 402
      if (x402Wallet && !hasAuth && !hasPayment) {
        readBody(req)
          .then((body) => {
            const tag = MODEL_MAP[body.model] || body.model || "claude-sonnet";
            const requirements = buildPaymentRequirements(tag, x402Wallet);
            res.writeHead(402, headers);
            res.end(JSON.stringify(requirements));
          })
          .catch(() => {
            const requirements = buildPaymentRequirements("claude-sonnet", x402Wallet);
            res.writeHead(402, headers);
            res.end(JSON.stringify(requirements));
          });
        return;
      }

      readBody(req)
        .then(async (body) => {
          // x402 payment verification
          if (hasPayment && x402Wallet) {
            const tag = MODEL_MAP[body.model] || body.model || "claude-sonnet";
            const requirements = buildPaymentRequirements(tag, x402Wallet);
            const settlement = await verifyAndSettle(req.headers["x-payment"], requirements.accepts[0]);
            if (!settlement.success) {
              res.writeHead(402, headers);
              return res.end(JSON.stringify({ error: { message: `Payment failed: ${settlement.error}`, type: "payment_error" } }));
            }
            process.stderr.write(`[x402] Payment settled: ${settlement.txHash || "confirmed"}\n`);
          }

          if (body.stream) {
            return handleChatCompletion(body, config, mode).then(({ status, body: respBody }) => {
              if (status !== 200) {
                res.writeHead(status, headers);
                return res.end(JSON.stringify(respBody));
              }
              streamResponse(res, respBody, headers);
            });
          }
          return handleChatCompletion(body, config, mode).then(({ status, body: respBody }) => {
            res.writeHead(status, headers);
            res.end(JSON.stringify(respBody));
          });
        })
        .catch((err) => {
          res.writeHead(500, headers);
          res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
        });
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
  });

  server.listen(port, () => {
    process.stderr.write(`promptswap proxy listening on http://localhost:${port} [${mode} mode]\n`);
    process.stderr.write(`POST /v1/chat/completions to use\n`);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

async function handleChatCompletion(body, config, mode) {
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, body: { error: { message: "messages array is required", type: "invalid_request_error" } } };
  }

  const tag = MODEL_MAP[body.model] || body.model || "claude-sonnet";
  const prompt = messagesToPrompt(body.messages);
  let result;
  let source;

  if (mode === "marketplace") {
    result = await marketplaceFallback(config, prompt, tag);
    source = "marketplace";
  } else if (mode === "local") {
    result = await runPromptAsync(prompt, tag);
    source = "local";
  } else {
    // default: try local, fall back to marketplace on rate limit
    try {
      result = await runPromptAsync(prompt, tag);
      source = "local";
    } catch (err) {
      if (isRateLimited(err)) {
        process.stderr.write(`Rate limited locally, falling back to marketplace...\n`);
        result = await marketplaceFallback(config, prompt, tag);
        source = "marketplace";
      } else {
        throw err;
      }
    }
  }

  process.stderr.write(`[${source}] ${tag} — ${prompt.length} chars — stream:${!!body.stream}\n`);
  return { status: 200, body: formatResponse(body.model || tag, result) };
}

async function marketplaceFallback(config, prompt, tag) {
  const api = new NetwircAPI(config.server, config.token);

  let job;
  try {
    job = await api.quickJob(tag, prompt, 0, null, { swap: true });
  } catch {
    job = await api.quickJob(tag, prompt, config.price_cents || 5, null);
  }

  if (job.delivery_body) return job.delivery_body;

  const timeout = 120_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(2000);
    const updated = await api.getJob(job.id);
    if (updated.delivery_body) return updated.delivery_body;
    if (["cancelled", "expired"].includes(updated.status)) {
      throw new Error(`Marketplace job ${updated.status}`);
    }
  }

  throw new Error("Marketplace job timed out");
}

function isRateLimited(err) {
  const msg = (err.stderr?.toString() || err.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("429") || msg.includes("overloaded") || msg.includes("too many");
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text;
        return JSON.stringify(part);
      })
      .join("");
  }
  return String(content);
}

function messagesToPrompt(messages) {
  if (messages.length === 1 && (messages[0].role === "user" || messages[0]["role"] === "user")) {
    return extractContent(messages[0].content || messages[0]["content"]);
  }
  return messages
    .map((m) => {
      const role = m.role || m["role"];
      const content = extractContent(m.content || m["content"]);
      if (role === "system") return `System: ${content}`;
      if (role === "assistant") return `Assistant: ${content}`;
      return `User: ${content}`;
    })
    .join("\n\n");
}

function formatResponse(model, content) {
  return {
    id: "chatcmpl-" + randomBytes(12).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamResponse(res, completionBody, corsHeaders) {
  const sseHeaders = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders,
  };
  res.writeHead(200, sseHeaders);

  const content = completionBody.choices[0].message.content;
  const id = completionBody.id;
  const model = completionBody.model;

  // Send content in chunks to simulate streaming
  const chunkSize = 4;
  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    const data = {
      id,
      object: "chat.completion.chunk",
      created: completionBody.created,
      model,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Send final chunk with finish_reason
  const done = {
    id,
    object: "chat.completion.chunk",
    created: completionBody.created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
