// A hard limit on what the mind may cost on this host's key: LIMIT_USD, in code.
//
// Before a request is sent, it reserves the most it could cost: its size
// bounds its input tokens (a token is at least one byte), and max_tokens
// bounds its output, thinking included. If the total with that reservation
// would pass the limit, the request is refused before anything is sent. When
// the answer comes, the reservation is replaced by what the API's usage says
// it cost. The total lives in a Redis store (Upstash, from the Vercel
// marketplace) and moves only by atomic INCRBY, so requests running at the
// same time cannot overshoot it either. The count runs only when a store is
// attached; a store that is attached but failing stops the mind. The hard
// limit that needs no store is the spend limit of the key's workspace in the
// Claude Console.
//
// The leading underscore keeps Vercel from serving this file as a function.

export const LIMIT_USD = 10;

// Dollars per million tokens (platform.claude.com pricing, November 2026).
// Cache writes are priced at the one-hour rate, the dearer one. A model that
// is missing here is never forwarded.
export const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 4, cacheRead: 0.1 },
};

const KEY = "ai-dan:spent-microdollars";   // millionths of a dollar
const LIMIT = LIMIT_USD * 1_000_000;
const OVERHEAD_TOKENS = 4_000;             // what the API adds around a request: tool instructions, markers
const PER_MESSAGE_TOKENS = 20;

/** Millionths of a dollar: tokens times dollars per million tokens. */
export function costOf(model, usage) {
  const price = PRICES[model];
  const n = (field) => (Number.isFinite(usage?.[field]) ? usage[field] : 0);
  return Math.ceil(
    n("input_tokens") * price.input +
    n("output_tokens") * price.output +
    n("cache_creation_input_tokens") * price.cacheWrite +
    n("cache_read_input_tokens") * price.cacheRead,
  );
}

/** The most a request can cost, in millionths of a dollar. */
export function worstCase(request) {
  const price = PRICES[request.model];
  const bytes = Buffer.byteLength(JSON.stringify(request));
  const input = bytes + OVERHEAD_TOKENS + PER_MESSAGE_TOKENS * request.messages.length;
  return Math.ceil(input * Math.max(price.input, price.cacheWrite) + request.max_tokens * price.output);
}

export const priced = (model) => Object.hasOwn(PRICES, model);

export function hasStore() {
  return storeConfig() !== null;
}

/** What this host has spent so far, in millionths of a dollar. */
export async function spent() {
  return Number(await redis(["GET", KEY])) || 0;
}

/** Reserve `amount` if it fits under the limit. False when it does not; then nothing is held. */
export async function reserve(amount) {
  const total = await redis(["INCRBY", KEY, amount]);
  if (total > LIMIT) {
    await redis(["INCRBY", KEY, -amount]);
    return false;
  }
  return true;
}

/** Replace a reservation with what the request really cost. */
export async function settle(reserved, actual) {
  if (actual !== reserved) await redis(["INCRBY", KEY, actual - reserved]);
}

export const dollars = (microdollars) => Math.round(microdollars / 10_000) / 100;

// --- the store: Upstash Redis over its REST API ------------------------------

function storeConfig() {
  // The Vercel marketplace names them KV_REST_API_*; Upstash's own docs, UPSTASH_REDIS_REST_*.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(command) {
  const store = storeConfig();
  if (!store) throw new Error("no spending store");
  const response = await fetch(store.url, {
    method: "POST",
    headers: { authorization: `Bearer ${store.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  });
  const answer = await response.json();
  if (!response.ok || answer.error) throw new Error(answer.error || `the store answered ${response.status}`);
  return answer.result;
}
