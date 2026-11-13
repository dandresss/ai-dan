// The host's access-code mode: a visitor without an API key can wake a mind
// on the host's key, if they know the code.
//
// Off unless the Vercel project sets both ANTHROPIC_API_KEY and
// LAB_ACCESS_CODE. It forwards only this lab's requests: the system prompt
// must be the lab's, and the model, tools and settings are always the
// server's own. Only the conversation comes from the browser.
import { createHash, timingSafeEqual } from "node:crypto";

import { Config } from "../lab/config.js";
import { systemPrompt, text, toolDefinitions } from "../lab/mind.js";
import { requestBody } from "../lab/model.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_REQUEST_BYTES = 2_000_000;   // a full 40-turn history stays well under this
const UPSTREAM_TIMEOUT_MS = 140_000;   // the browser gives up at 120 s

export function GET() {
  return json(200, { available: configured() });
}

export async function POST(request) {
  if (!configured()) return error(404, "not_found_error", "The access-code mode is off on this host.");
  if (!codeMatches(request.headers.get("x-lab-access-code"))) {
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

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify(checked),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (exc) {
    const timedOut = exc?.name === "TimeoutError";
    return error(timedOut ? 504 : 502, "api_error",
      timedOut ? "The model took too long to answer." : "The host could not reach the model.");
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// --- what counts as this lab's request ------------------------------------

/** The request to forward, built from the server's own settings, or an error text. */
export function labRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "The request must be an object.";
  const memory = Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "remember");
  const config = new Config({ MEMORY_ENABLED: memory });
  if (!isLabPrompt(config, body.system)) return "That is not this lab's system prompt.";
  const problem = messagesProblem(body.messages);
  if (problem) return problem;
  return requestBody(config, body.system, toolDefinitions(config), body.messages);
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

const USER_BLOCKS = new Set(["text", "tool_result"]);
const ASSISTANT_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/** The conversation must look like the harness's: wakes, tool results and the mind's own turns. */
function messagesProblem(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "There is no conversation.";
  for (const message of messages) {
    const allowed = message?.role === "user" ? USER_BLOCKS : message?.role === "assistant" ? ASSISTANT_BLOCKS : null;
    if (!allowed || !Array.isArray(message.content)) return "The conversation is not this lab's.";
    for (const block of message.content) {
      if (!allowed.has(block?.type)) return "The conversation is not this lab's.";
      if (message.role === "user" && block.type === "text" && !isWake(block.text)) {
        return "The conversation is not this lab's.";
      }
      if (block.type === "tool_result" && typeof block.content !== "string") {
        return "The conversation is not this lab's.";
      }
    }
  }
  return null;
}

/** A wake message: {"t": seconds} and, when the person spoke, "heard". */
function isWake(words) {
  try {
    const wake = JSON.parse(words);
    return typeof wake?.t === "number" &&
      Object.keys(wake).every((key) => key === "t" || key === "heard") &&
      (wake.heard === undefined || (Array.isArray(wake.heard) && wake.heard.every((line) => typeof line === "string")));
  } catch {
    return false;
  }
}

// --- helpers -----------------------------------------------------------------

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.LAB_ACCESS_CODE);
}

function codeMatches(given) {
  if (typeof given !== "string" || given === "") return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(process.env.LAB_ACCESS_CODE));
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
