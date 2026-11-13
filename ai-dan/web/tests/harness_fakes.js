// Fakes for the harness tests: a world with a clock the test sets, a body that
// answers instantly, and a model that plays a script and checks every message
// list it is sent. Port of tests/harness_fakes.py.
import assert from "node:assert/strict";
import { pyDumps } from "../lab/py.js";

const BODY_TOOLS = ["play", "stop", "sense", "set_color"];

class WorldClosed extends Error {
  constructor() {
    super("The lab shut down while a call was waiting for its tick.");
    this.name = "WorldClosed";
  }
}

// A log that keeps the exact lines (as pyDumps writes them) and the
// JSON-normalised events, like SessionLog and its feed.
class FakeLog {
  constructor() {
    this.lines = [];
    this.events = [];
  }

  write(event) {
    const line = pyDumps(event);
    this.lines.push(line);
    this.events.push(JSON.parse(line));
  }

  writeHeader(config, extra) {
    this.write({ type: "header", version: 1, started_at: "2000-01-01T00:00:00",
                 config: config.toDict(), ...extra });
  }
}

class FakeBody {
  constructor(world) {
    this.world = world;
    this.calls = [];   // [name, args]
  }

  async call(name, args = null) {
    const world = this.world;
    if (world.closed || world.closeOnCall) {
      world.closed = true;
      throw new WorldClosed();
    }
    this.calls.push([name, args]);
    let result;
    if (name === "sense") {
      const grid = () => Array.from({ length: 8 }, () => Array(8).fill(0));
      result = { t: world.t, actual: grid(), gap: grid(), person: null, color: [255, 255, 255] };
    } else if (BODY_TOOLS.includes(name)) {
      result = { ok: true, t: world.t };
    } else {
      result = { ok: false, t: world.t, error: "unknown" };
    }
    world.log.write({ type: "call", turn: world.turn, tick: Math.round(world.t * 50),
                      t: world.t, name, args, result });
    world.t = Math.round((world.t + world.callS) * 100) / 100;
    return result;
  }
}

export class FakeWorld {
  constructor() {
    this.events = [];          // a FIFO of ["enter", t], ["leave", t], ["voice", t, text]
    this.t = 0;
    this.turn = 0;
    this.log = new FakeLog();
    this.closed = false;
    this.closeOnCall = false;
    this.callS = 0;            // simulated seconds each body call takes
    this.body = new FakeBody(this);
  }

  remoteBody() { return this.body; }
  enter() { this.events.push(["enter", this.t]); }
  leave() { this.events.push(["leave", this.t]); }
  say(line) { this.events.push(["voice", this.t, line]); }

  logged(kind = null) {
    return this.log.events.filter((e) => kind === null || e.type === kind);
  }
}

export const noSleep = () => Promise.resolve();

export function response(...blocks) {
  let stop = null;
  if (blocks.length && typeof blocks[blocks.length - 1].stop === "string" && !blocks[blocks.length - 1].type) {
    stop = blocks.pop().stop;   // response(..., { stop: "refusal" })
  }
  stop ??= blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return { content: blocks, stop_reason: stop, model: "fake", input_tokens: 10, output_tokens: 5 };
}

export const say = (words) => ({ type: "text", text: words });
export const think = (words, signature = "sig") => ({ type: "thinking", thinking: words, signature });

let ids = 0;
export function use(name, args = null) {
  ids += 1;
  return { type: "tool_use", id: `toolu_${String(ids).padStart(5, "0")}`, name, input: args ?? {} };
}

// Plays `script` in order: each entry is a response, an Error to throw, or a
// function(messages) returning either. When the script runs out it answers
// with a quiet end of turn.
export class FakeModel {
  constructor(script = [], { onCall = null } = {}) {
    this.name = "fake";
    this.script = [...script];
    this.onCall = onCall;
    this.sent = [];
    this.systems = [];
    this.tools = [];
  }

  async respond(system, tools, messages) {
    assertValid(messages);
    this.sent.push(structuredClone(messages));
    this.systems.push(system);
    this.tools.push(tools);
    if (this.onCall) this.onCall(this.sent.length);
    let item = this.script.length ? this.script.shift() : response(say("..."));
    if (typeof item === "function") item = item(messages);
    if (item instanceof Error) throw item;
    return structuredClone(item);
  }
}

// The message list the API will accept: starts with the user; no empty message
// or text block; every tool_use answered in the next user message; every
// tool_result answers the assistant message just before it; thinking blocks
// only inside the current turn (after the last wake text).
export function assertValid(messages) {
  assert.ok(messages.length && messages[0].role === "user");
  let lastWake = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && m.content.some((b) => b.type === "text")) lastWake = i;
  });
  assert.ok(lastWake >= 0);
  messages.forEach((m, i) => {
    assert.ok(m.role === "user" || m.role === "assistant");
    assert.ok(i === 0 || m.role !== messages[i - 1].role, `message ${i} repeats a role`);
    assert.ok(m.content.length, `message ${i} is empty`);
    for (const b of m.content) {
      if (b.type === "text") assert.ok(b.text.trim(), `message ${i} has an empty text block`);
      if (b.type === "thinking" || b.type === "redacted_thinking") {
        assert.ok(i > lastWake, `message ${i} replays a thinking block from a past turn`);
      }
    }
    if (m.role === "assistant") {
      const used = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
      if (used.length) {
        assert.ok(i + 1 < messages.length, `message ${i}: tool_use with no answer`);
        const next = messages[i + 1];
        assert.equal(next.role, "user");
        const answered = next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
        assert.deepEqual([...answered].sort(), [...used].sort(), `message ${i}: unanswered tool_use`);
        // results come before any text in that user message
        const kinds = next.content.map((b) => b.type);
        assert.deepEqual(kinds, [...kinds].sort((a, b) => (a !== "tool_result") - (b !== "tool_result")));
      }
    } else {
      const results = m.content.filter((b) => b.type === "tool_result");
      if (results.length) {
        const prev = messages[i - 1];
        assert.equal(prev.role, "assistant");
        const ids = new Set(prev.content.filter((b) => b.type === "tool_use").map((b) => b.id));
        for (const r of results) assert.ok(ids.has(r.tool_use_id));
      }
      for (const r of results) JSON.parse(r.content);
    }
  });
}
