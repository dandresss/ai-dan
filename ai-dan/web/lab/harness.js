// The mind loop: what wakes the agent, the anatomy of a turn, in-session
// memory, limits and the mind's half of the log (harness.md).
// Port of lab/harness.py.
//
// The loop is a thin shell around `step()`, which makes every decision from
// `world.t` and the event queue. Tests drive `step()` directly with a clock
// they control; nothing here reads the wall clock except the waits (retries,
// and the pause between looks at the world).
import { pyDumps } from "./py.js";
import { loadNote, saveNote, systemPrompt, text, toolDefinitions } from "./mind.js";
import { ModelError } from "./model.js";

export const RETRY_WAITS_S = [2, 4, 8];   // harness.md: retried up to three times, growing waits

// What Python's str.strip() treats as whitespace (JS trim() differs a little).
const isPySpace = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000;
};
const isBlank = (s) => [...(s ?? "")].every(isPySpace);
const emptyText = (block) => block.type === "text" && isBlank(block.text);

// A store that lives and dies with the page, for a visitor who gave none.
function memoryStore() {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
}

export class Harness {
  // `sleep(seconds)` returns a promise; tests replace it to skip the waits.
  constructor(world, model, config, { noteStore = null, retryWaits = RETRY_WAITS_S, sleep } = {}) {
    this.world = world;
    this.model = model;
    this.config = config;
    this.noteStore = config.MEMORY_ENABLED ? (noteStore ?? memoryStore()) : null;
    // Frozen for the whole session: a note written now is for the next one.
    this.system = systemPrompt(config, loadNote(this.noteStore));
    this.tools = toolDefinitions(config);
    this.body = world.remoteBody();
    this.retryWaits = retryWaits;
    this.sleep = sleep ?? ((seconds) => this._wait(seconds));

    // The conversation, kept in full; fading is applied when it is sent.
    this.messages = [];
    this.senseTurn = new Map();     // tool_use id -> [turn, t]
    this.pendingResults = [];       // results that travel with the next wake

    // Session state
    this.turn = 0;
    this.startedAt = null;
    this.leftAt = null;             // outside, but still within the grace
    this.departed = false;          // departure registered; no pulse until return
    this.lastTurnEnd = null;
    this.reasons = [];
    this.heard = [];
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.ended = false;

    this.stopped = false;
    this._wakeSleepers = new Set();
    this._running = null;           // the step in progress
    this._loop = null;
  }

  // --- lifecycle -----------------------------------------------------------
  // Write the header, then start the loop. Tests pass `runLoop: false` and
  // call `step()` themselves.
  start({ runLoop = true } = {}) {
    this.world.log.writeHeader(this.config, {
      t: this.world.t,
      prompt_version: this.config.PROMPT_VERSION,
      prompt: this.system,
      model: this.model.name,
      tools: this.tools.map((tool) => tool.name),
      memory_enabled: this.config.MEMORY_ENABLED,
      mind: this.model.name === "scripted" ? "scripted" : "live",
    });
    if (runLoop) this._loop = this._run();
  }

  // Close the world before calling this, so a body call the mind is waiting
  // on is released rather than left waiting for a tick. A request in flight is
  // cancelled; whatever else arrives after the close is discarded.
  async stop(reason = "window_closed") {
    this.stopped = true;
    this.model.abort?.();
    for (const wake of this._wakeSleepers) wake();
    // Long enough for an interrupted turn to log its end.
    if (this._running) {
      let timer;
      const patience = new Promise((resolve) => { timer = setTimeout(resolve, 1000); });
      await Promise.race([this._running.catch(() => {}), patience]);
      clearTimeout(timer);
    }
    this._end(reason);
  }

  async _run() {
    while (!this.ended && !this.stopped) {
      if (!(await this.step())) await this.sleep(0.02);
    }
  }

  _wait(seconds) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this._wakeSleepers.delete(done); resolve(); };
      const timer = setTimeout(done, seconds * 1000);
      this._wakeSleepers.add(done);
    });
  }

  // --- deciding when to wake -----------------------------------------------
  // Take in what happened, then run a turn if something should wake the mind.
  // Resolves true if a turn ran.
  async step() {
    if (this.ended) return false;
    this._running = this._step();
    try {
      return await this._running;
    } finally {
      this._running = null;
    }
  }

  async _step() {
    this._drainEvents();
    if (this.startedAt === null) return false;
    const cfg = this.config;
    const now = this.world.t;
    if (now >= this.startedAt + cfg.MAX_SESSION_MIN * 60) {
      this._end("max_minutes");
      return false;
    }
    if (this.leftAt !== null && now - this.leftAt >= cfg.ABSENCE_GRACE_S) {
      this.leftAt = null;
      this.departed = true;
      this._addReason("departure");
    }
    const present = !this.departed && this.leftAt === null;
    if (this.reasons.length === 0 && present && this.lastTurnEnd !== null
        && now - this.lastTurnEnd >= cfg.PULSE_S) {
      this._addReason("pulse");
    }
    if (this.reasons.length === 0) return false;

    const { reasons, heard } = this;
    this.reasons = [];
    this.heard = [];
    await this._runTurn(reasons, heard);
    if (!this.ended && this.turn >= cfg.MAX_TURNS) this._end("max_turns");
    return true;
  }

  _drainEvents() {
    let event;
    while ((event = this.world.events.shift()) !== undefined) {
      const [kind, t] = event;
      if (kind === "enter") {
        if (this.startedAt === null) {
          this.startedAt = t;
          this._addReason("arrival");
        } else if (this.departed) {
          this.departed = false;
          this._addReason("arrival");
        } else if (this.leftAt !== null && t - this.leftAt >= this.config.ABSENCE_GRACE_S) {
          // Gone for longer than the grace and back again while a turn was
          // running: judged by when it happened, not by now.
          this._addReason("departure");
          this._addReason("arrival");
        }
        this.leftAt = null;   // back within the grace: not an event
      } else if (kind === "leave") {
        if (!this.departed) this.leftAt = t;
      } else if (kind === "voice") {
        this.heard.push(event[2]);
        this._addReason("voice");
      }
    }
  }

  _addReason(reason) {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }

  // --- one turn --------------------------------------------------------------
  async _runTurn(reasons, heard) {
    const cfg = this.config;
    this.turn += 1;
    const turn = this.turn;
    this.world.turn = turn;

    const wake = { t: this.world.t };
    if (heard.length) wake.heard = [...heard];
    const wakeText = pyDumps(wake);
    const blocks = [...this.pendingResults, { type: "text", text: wakeText }];
    this.pendingResults = [];
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") {
      // The last turn ended without an answer from the model. Roles must
      // alternate, so this wake joins the message that is still waiting.
      this.messages[this.messages.length - 1] = { role: "user", content: [...last.content, ...blocks] };
    } else {
      this.messages.push({ role: "user", content: blocks });
    }
    const first = this.messages.length - 1;
    this._log({ type: "wake", turn, reasons, message: wakeText });

    let calls = 0, capped = false, skipped = false, endAfter = null;
    const deadline = this.startedAt + cfg.MAX_SESSION_MIN * 60;
    try {
      while (!this.ended) {
        if (this.world.t >= deadline) {
          endAfter = "max_minutes";
          break;
        }
        const response = await this._respond(turn);
        if (response === null || this.ended || this.stopped) {
          skipped = response === null && !this.stopped;
          break;
        }
        this._log({
          type: "usage", turn, model: response.model, stop_reason: response.stop_reason,
          input_tokens: response.input_tokens, output_tokens: response.output_tokens,
        });
        this.inputTokens += response.input_tokens;
        this.outputTokens += response.output_tokens;
        if (response.stop_reason === "refusal") {
          skipped = true;
          break;
        }

        const content = response.content.filter((b) => !emptyText(b));
        this._logThoughts(turn, content);
        const uses = content.filter((b) => b.type === "tool_use");
        if (content.length) this.messages.push({ role: "assistant", content });
        if (uses.length === 0) break;
        if (this.world.t >= deadline) {
          endAfter = "max_minutes";   // the session is over: leave the body alone
          break;
        }
        // A response cut off at the output cap may end in a half-written
        // call that still parses. The body must not run a movement the
        // mind did not finish ordering, so none of its calls are run.
        const cutOff = response.stop_reason === "max_tokens";

        const results = [];
        for (const use of uses) {
          if (this.ended) return;
          let result;
          if (calls < cfg.MAX_TOOL_CALLS && !cutOff) {
            result = await this._runTool(turn, use);
            calls += 1;
          } else {
            result = { ok: false, t: this.world.t, error: text(cfg, "past_cap") };
            this._log({ type: "call", turn, name: use.name ?? null, args: use.input ?? null, result });
          }
          results.push(toolResult(use, result));
        }
        if (cutOff || calls >= cfg.MAX_TOOL_CALLS) {
          capped = true;
          this.pendingResults = results;
          break;
        }
        this.messages.push({ role: "user", content: results });
      }
    } catch (error) {
      if (error?.name !== "WorldClosed") throw error;
      endAfter = "window_closed";
    } finally {
      this._settle(first);
      this.lastTurnEnd = this.world.t;
      this._log({ type: "turn_end", turn, tool_calls: calls, capped, skipped });
    }
    if (endAfter) this._end(endAfter);
  }

  // One model call with the harness's retries. null means give up.
  async _respond(turn) {
    const messages = this._outgoing(turn);
    const attempts = 1 + this.retryWaits.length;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.ended || this.stopped) return null;
      let error, retryable;
      try {
        return await this.model.respond(this.system, this.tools, messages);
      } catch (exc) {
        // Keep the loop alive whatever happens.
        if (exc instanceof ModelError) {
          error = exc.message;
          retryable = exc.retryable;
        } else {
          error = `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
          retryable = false;
        }
      }
      if (this.stopped) return null;   // the request was cancelled by stop(): not an error
      this._log({ type: "api_error", turn, attempt, error });
      if (!retryable || attempt === attempts) return null;
      await this.sleep(this.retryWaits[attempt - 1]);
    }
    return null;
  }

  async _runTool(turn, use) {
    const name = use.name ?? null;
    const args = use.input ?? null;
    if (name === "remember" && this.config.MEMORY_ENABLED) {
      const error = saveNote(this.config, this.noteStore, use.input);
      let result = { ok: true, t: this.world.t };
      if (error) result = { ok: false, t: this.world.t, error };
      this._log({ type: "call", turn, name, args, result });
      return result;
    }
    // Everything else is the body's to answer, unknown names included.
    const result = await this.body.call(use.name, use.input);
    if (name === "sense" && result !== null && typeof result === "object") {
      this.senseTurn.set(use.id, [turn, result.t ?? null]);
    }
    return result;
  }

  // --- memory ------------------------------------------------------------------
  // The history as sent during `turn`: the last MEMORY_FULL_TURNS finished
  // turns in full, older `sense` results faded to a marker. The result is the
  // same for every call within a turn, so in-turn thinking blocks stay valid.
  _outgoing(turn) {
    const oldestFull = turn - this.config.MEMORY_FULL_TURNS;
    return this.messages.map((message) => {
      let content = message.content;
      content = message.role === "user"
        ? content.map((block) => this._faded(block, oldestFull))
        : [...content];
      return { role: message.role, content };
    });
  }

  _faded(block, oldestFull) {
    if (block.type !== "tool_result") return block;
    const origin = this.senseTurn.get(block.tool_use_id);
    if (origin === undefined || origin[0] >= oldestFull) return block;
    return { ...block, content: pyDumps({ t: origin[1], faded: true }) };
  }

  // A finished turn: thinking becomes text with the same words, in place;
  // empty blocks go; a message left empty goes (ARCHITECTURE.md decision 3).
  _settle(first) {
    const settled = this.messages.slice(0, first);
    for (const message of this.messages.slice(first)) {
      if (message.role !== "assistant") {
        settled.push(message);
        continue;
      }
      const content = [];
      for (const block of message.content) {
        if (block.type === "thinking") {
          if (!isBlank(block.thinking)) content.push({ type: "text", text: block.thinking });
        } else if (block.type === "redacted_thinking" || emptyText(block)) {
          continue;
        } else {
          content.push(block);
        }
      }
      if (content.length) settled.push({ role: "assistant", content });
    }
    this.messages = settled;
  }

  // --- log -----------------------------------------------------------------------
  _logThoughts(turn, content) {
    for (const block of content) {
      const words = block.type === "text" ? block.text : block.thinking;
      if ((block.type === "text" || block.type === "thinking") && !isBlank(words)) {
        this._log({ type: "thought", turn, kind: block.type, text: words });
      }
    }
  }

  _log({ type, ...fields }) {
    if (this.ended) return;   // nothing from the mind after `close`
    this.world.log.write({ type, t: this.world.t, ...fields });
  }

  _end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.world.log.write({
      type: "close", t: this.world.t, reason, turns: this.turn,
      input_tokens: this.inputTokens, output_tokens: this.outputTokens,
    });
  }
}

function toolResult(use, result) {
  return { type: "tool_result", tool_use_id: use.id ?? null, content: pyDumps(result) };
}
