// The model behind the mind. Port of lab/model.py.
//
// AnthropicModel  the real one: one request per `respond`, no retries (the
//                 harness owns retries), the API's own content blocks.
//                 Always through the host (POST /api/mind), which holds the
//                 key: a local Python server or the Vercel function.
// ScriptedModel   a wiring test for the dry run: a fixed, mechanical pattern
//                 that exercises every tool. It is not a mind and must not
//                 look like one.
import { thinkingParam } from "./mind.js";

// A failed model request. `retryable` says whether trying again may help.
export class ModelError extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = "ModelError";
    this.retryable = retryable;
  }
}

// The Messages API body, key order as the Python SDK call has it.
export function requestBody(config, system, tools, messages) {
  return {
    model: config.MODEL,
    max_tokens: config.MAX_TOKENS,
    system,
    tools,
    messages,
    thinking: thinkingParam(config),
    output_config: { effort: config.EFFORT },
  };
}

// Rate limit, 408, 409 and 5xx are worth retrying; any other 4xx is not.
function retryableStatus(code) {
  return code === 429 || code === 408 || code === 409 || code >= 500;
}

export class AnthropicModel {
  // The access code is optional: a local host asks for none.
  constructor(config, { accessCode, endpoint = "/api/mind" } = {}, { fetch, timeoutMs = 120000 } = {}) {
    this.config = config;
    this.name = config.MODEL;
    this.accessCode = accessCode;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetch = fetch ?? ((...args) => globalThis.fetch(...args));
    this.controller = null;
  }

  // Cancel the request in flight, if any. Its respond() rejects, not retryable.
  abort() {
    this.controller?.abort("cancelled");
  }

  async respond(system, tools, messages) {
    const headers = { "content-type": "application/json" };
    if (typeof this.accessCode === "string" && this.accessCode) headers["x-lab-access-code"] = this.accessCode;
    const body = JSON.stringify(requestBody(this.config, system, tools, messages));
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    try {
      let raw, response;
      try {
        response = await this.fetch(this.endpoint, { method: "POST", headers, body, signal: controller.signal });
        // Reading the body is still part of the request, so it stays under the timer.
        raw = await response.text();
      } catch (error) {
        throw this._fetchFailure(error, controller.signal);
      }
      if (!response.ok) throw this._statusError(response.status, raw);
      return this._answer(raw);
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  _fetchFailure(error, signal) {
    if (signal.aborted) {
      if (signal.reason === "timeout") {
        // Not retried: a request that ran out of time once is likely to do so
        // again, and the turn would hang for minutes.
        return new ModelError(`Timeout: no answer within ${this.timeoutMs / 1000} s`, false);
      }
      return new ModelError("Cancelled: the request was abandoned", false);
    }
    return new ModelError(`ConnectionError: ${this._clean(error?.message ?? error)}`, true);
  }

  _statusError(code, raw) {
    let message = raw;
    try {
      message = JSON.parse(raw).error.message ?? raw;
    } catch { /* not the API's JSON: keep the raw text */ }
    return new ModelError(`HTTP ${code}: ${this._clean(message)}`, retryableStatus(code));
  }

  _answer(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ModelError("The answer was not JSON", false);
    }
    return {
      content: data.content,
      stop_reason: data.stop_reason,
      model: data.model,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
    };
  }

  // The access code must never reach a log, even if a server echoes it back.
  _clean(message) {
    const code = this.accessCode;
    return code ? String(message).split(code).join("[code]") : String(message);
  }
}

// --- the wiring test -------------------------------------------------------

// Turns, each a list of responses, each a list of tool calls. A response with
// no calls ends the turn. The cycle repeats for as long as it is woken.
function wiringScript(config) {
  const rows = config.GRID_ROWS;
  const cols = config.GRID_COLS;
  const pins = (keep) => {
    const out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (keep((r + c) % 2)) out.push([r, c]);
    return out;
  };
  const checkerboard = {
    tracks: [
      { pins: pins((s) => s === 0), keyframes: [[0, 0], [1, 1]], ease: "linear" },
      { pins: pins((s) => s === 1), keyframes: [[0, 0], [1, 0]], ease: "linear" },
    ],
  };
  // One corner pin blinks in a square pattern: exercises `loop` on one pin only.
  const blink = {
    tracks: [{
      pins: [[0, 0]], loop: true, ease: "linear",
      keyframes: [[0, 0], [0.05, 1], [0.5, 1], [0.55, 0], [1, 0]],
    }],
  };
  // Rows rise and fall one after another, once.
  const sweep = {
    tracks: Array.from({ length: rows }, (_, r) => ({
      pins: Array.from({ length: cols }, (_, c) => [r, c]),
      delay_s: r * 0.25, ease: "linear",
      keyframes: [[0, 0], [0.5, 1], [1, 0]],
    })),
  };
  // A pin outside the grid: the body must reject the whole call.
  const invalid = { tracks: [{ pins: [[rows + 1, cols + 1]], keyframes: [[0, 0], [1, 1]] }] };
  const tool = (name, args) => [name, args];
  return [
    [[tool("sense", {})], []],
    [[tool("play", checkerboard), tool("sense", {})], []],
    [[tool("set_color", { rgb: [0, 128, 255] }), tool("play", blink)], []],
    [[tool("play", sweep)], [tool("sense", {})], []],
    [[tool("stop", {})], []],
    [[tool("play", invalid)], []],
  ];
}

// Not a mind: a fixed test pattern that checks the wiring without a key.
export class ScriptedModel {
  constructor(config) {
    this.name = "scripted";
    this.script = wiringScript(config);
    this.turn = -1;
    this.step = 0;
    this.responses = 0;
    this.ids = 0;
  }

  async respond(system, tools, messages) {
    // A turn begins with a user message that carries the wake text.
    const last = messages.length ? messages[messages.length - 1].content : [];
    if (typeof last === "string" || last.some((b) => b.type === "text")) {
      this.turn += 1;
      this.step = 0;
    }
    const turn = this.script[this.turn % this.script.length];
    const calls = turn[Math.min(this.step, turn.length - 1)];
    this.step += 1;
    this.responses += 1;

    const label = `wiring test: step ${this.responses}`;
    const content = [{ type: "text", text: calls.length ? label : label + ", done" }];
    for (const [name, args] of calls) {
      this.ids += 1;
      content.push({
        type: "tool_use",
        id: `toolu_wiring_${String(this.ids).padStart(4, "0")}`,
        name,
        input: structuredClone(args),
      });
    }
    return {
      content,
      stop_reason: calls.length ? "tool_use" : "end_turn",
      model: this.name,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
}
