// The host's access-code mode: a visitor without an API key can wake a mind
// on the host's key, if they know the code.
//
// Off unless the Vercel project sets both ANTHROPIC_API_KEY and
// LAB_ACCESS_CODE. It forwards only this lab's requests: the system prompt
// must be the lab's, the model, tools and settings are always the server's
// own, and the conversation is rebuilt block by block from the fields the
// harness writes. Anyone holding the code can still spend the host's key, so
// give the code only to people you trust and set a spend limit on the key.
import { createHash, timingSafeEqual } from "node:crypto";

import { Config } from "../lab/config.js";
import { systemPrompt, text, toolDefinitions } from "../lab/mind.js";
import { requestBody } from "../lab/model.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_REQUEST_BYTES = 2_000_000;   // a full 40-turn history stays well under this
const UPSTREAM_TIMEOUT_MS = 140_000;   // the browser gives up at 120 s
const MAX_HEARD_LINES = 20;            // lines the person said between two wakes
const MAX_HEARD_CHARS = 200;           // the page's limit for one line
const MAX_TEXT_CHARS = 20_000;         // one block of the mind's own text or thinking

// Wrong codes, per caller, while this function instance lives. Not a real
// rate limit (instances come and go), but it makes guessing slow.
const FAILED_LIMIT = 10;
const FAILED_WINDOW_MS = 10 * 60_000;
const failures = new Map();

export function GET() {
  return json(200, { available: configured() });
}

export async function POST(request) {
  if (!configured()) return error(404, "not_found_error", "The access-code mode is off on this host.");
  const caller = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (tooManyFailures(caller)) {
    return error(429, "rate_limit_error", "Too many wrong access codes. Wait a few minutes.");
  }
  if (!codeMatches(request.headers.get("x-lab-access-code"))) {
    recordFailure(caller);
    return error(401, "authentication_error", "That access code is not right.");
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    return error(413, "request_too_large", "The conversation is too long for this host.");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, "invalid_request_error", "The request is not JSON.");
  }

  const checked = labRequest(body);
  if (typeof checked === "string") return error(400, "invalid_request_error", checked);

  // Stop the upstream request when the browser gives up, so it is not billed for nothing.
  const signal = AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), request.signal].filter(Boolean));
  try {
    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify(checked),
      signal,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (exc) {
    const timedOut = exc?.name === "TimeoutError";
    return error(timedOut ? 504 : 502, "api_error",
      timedOut ? "The model took too long to answer." : "The host could not reach the model.");
  }
}

// --- what counts as this lab's request ------------------------------------

/** The request to forward, built from the server's own settings, or an error text. */
export function labRequest(body) {
  if (!isObject(body)) return "The request must be an object.";
  const memory = Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "remember");
  const config = new Config({ MEMORY_ENABLED: memory });
  if (!isLabPrompt(config, body.system)) return "That is not this lab's system prompt.";
  const messages = labMessages(body.messages, config);
  if (!messages) return "The conversation is not this lab's.";
  return requestBody(config, body.system, toolDefinitions(config), messages);
}

function isLabPrompt(config, system) {
  if (typeof system !== "string") return false;
  if (system === systemPrompt(config, null)) return true;
  if (!config.MEMORY_ENABLED) return false;
  // Later-days mode: the prompt may end with the note the mind left itself.
  const prefix = `${systemPrompt(config, null)}\n\n${text(config, "note_heading")}\n`;
  if (!system.startsWith(prefix)) return false;
  const note = system.slice(prefix.length);
  return note.length > 0 && [...note].length <= config.NOTE_MAX_CHARS && systemPrompt(config, note) === system;
}

/**
 * The conversation as the harness writes it, rebuilt from the fields each
 * block may have, so nothing else (images, cache settings, documents) gets
 * through. Null if anything does not fit.
 */
function labMessages(messages, config) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const tools = new Set(toolDefinitions(config).map((tool) => tool.name));
  const out = [];
  for (const message of messages) {
    if (!isObject(message) || !Array.isArray(message.content) || message.content.length === 0) return null;
    const rebuild = message.role === "user" ? userBlock : message.role === "assistant" ? assistantBlock : null;
    if (!rebuild) return null;
    const content = message.content.map((block) => (isObject(block) ? rebuild(block, tools) : null));
    if (content.includes(null)) return null;
    out.push({ role: message.role, content });
  }
  return out;
}

function userBlock(block) {
  if (block.type === "text" && isWake(block.text)) return { type: "text", text: block.text };
  if (block.type === "tool_result" && isId(block.tool_use_id) && isResult(block.content)) {
    return { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content };
  }
  return null;
}

function assistantBlock(block, tools) {
  switch (block.type) {
    case "text":
      return isText(block.text) ? { type: "text", text: block.text } : null;
    case "thinking":
      return isText(block.thinking) && typeof block.signature === "string"
        ? { type: "thinking", thinking: block.thinking, signature: block.signature } : null;
    case "redacted_thinking":
      return typeof block.data === "string" ? { type: "redacted_thinking", data: block.data } : null;
    case "tool_use":
      // Unknown tool names are allowed: the mind may call one, and the body answers it.
      return isId(block.id) && typeof block.name === "string" && block.name.length <= 64 && isObject(block.input)
        ? { type: "tool_use", id: block.id, name: block.name, input: block.input } : null;
    default:
      return null;
  }
}

/** A wake message: {"t": seconds} and, when the person spoke, "heard". */
function isWake(words) {
  let wake;
  try {
    wake = JSON.parse(words);
  } catch {
    return false;
  }
  if (!isObject(wake) || typeof wake.t !== "number") return false;
  if (!Object.keys(wake).every((key) => key === "t" || key === "heard")) return false;
  if (wake.heard === undefined) return true;
  return Array.isArray(wake.heard) && wake.heard.length <= MAX_HEARD_LINES &&
    wake.heard.every((line) => typeof line === "string" && [...line].length <= MAX_HEARD_CHARS);
}

/** A tool result is the body's (or the note's) answer: a small JSON object with a time. */
function isResult(content) {
  if (typeof content !== "string" || content.length > 10_000) return false;
  try {
    const result = JSON.parse(content);
    return isObject(result) && (typeof result.t === "number" || result.t === null);
  } catch {
    return false;
  }
}

const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isText = (x) => typeof x === "string" && x.length <= MAX_TEXT_CHARS;
const isId = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);

// --- helpers -----------------------------------------------------------------

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.LAB_ACCESS_CODE?.trim());
}

function codeMatches(given) {
  if (typeof given !== "string" || given.trim() === "") return false;
  const digest = (value) => createHash("sha256").update(value.trim()).digest();
  return timingSafeEqual(digest(given), digest(process.env.LAB_ACCESS_CODE));
}

function tooManyFailures(caller) {
  const now = Date.now();
  const recent = (failures.get(caller) || []).filter((at) => now - at < FAILED_WINDOW_MS);
  failures.set(caller, recent);
  if (failures.size > 10_000) failures.clear();   // keep memory bounded
  return recent.length >= FAILED_LIMIT;
}

function recordFailure(caller) {
  const recent = failures.get(caller) || [];
  recent.push(Date.now());
  failures.set(caller, recent);
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function error(status, type, message) {
  return json(status, { type: "error", error: { type, message } });
}
