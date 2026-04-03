// x402 payment protocol support for the proxy server.
// Zero dependencies — uses Node's built-in fetch() to talk to the facilitator.

const FACILITATOR_URL = "https://x402.org/facilitator";
const CHAIN = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

// 1 swap credit = $0.001 USDC
const CREDIT_TO_USDC = 0.001;

// Mirrors SWAP_CREDIT_WEIGHTS from the server
const CREDIT_WEIGHTS = {
  "claude-opus": 25,
  "claude-sonnet": 10,
  "claude-haiku": 3,
  codex: 10,
  prompt: 1,
  summarize: 1,
  tldr: 1,
};

export function priceUsdc(tag) {
  const credits = CREDIT_WEIGHTS[tag] || 1;
  return credits * CREDIT_TO_USDC;
}

function priceUnits(tag) {
  return String(Math.round(priceUsdc(tag) * 10 ** USDC_DECIMALS));
}

export function buildPaymentRequirements(tag, payTo) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: CHAIN,
        maxAmountRequired: priceUnits(tag),
        resource: "/v1/chat/completions",
        description: `${tag} inference`,
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 300,
        asset: USDC_BASE,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

export function buildPricingResponse() {
  const prices = {};
  for (const [tag, credits] of Object.entries(CREDIT_WEIGHTS)) {
    prices[tag] = {
      credits,
      usdc: credits * CREDIT_TO_USDC,
      usdc_units: String(Math.round(credits * CREDIT_TO_USDC * 10 ** USDC_DECIMALS)),
    };
  }
  return { chain: CHAIN, asset: USDC_BASE, prices };
}

export async function verifyAndSettle(xPaymentHeader, paymentRequirements) {
  try {
    const res = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: xPaymentHeader,
        paymentRequirements,
      }),
    });

    const body = await res.json();

    if (res.ok && body.success) {
      return { success: true, txHash: body.transaction?.hash || body.txHash };
    }
    return { success: false, error: body.error || `Settlement failed (HTTP ${res.status})` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function extractPayerAddress(xPaymentHeader) {
  try {
    const decoded = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString());
    return decoded.payload?.authorization?.from || decoded.from || "0x0";
  } catch {
    return "0x0";
  }
}
