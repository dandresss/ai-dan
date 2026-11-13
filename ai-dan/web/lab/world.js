// The lab's glue: one body, one log, two queues. A port of lab/world.py.
//
// World        the live lab. The page calls `tick()` 50 times a second; the
//              mind reaches the body through `remoteBody()`.
// ReplayWorld  the same surface, fed from a session log instead of a person
//              and a mind. No API calls, same body states.

import { Config } from "./config.js";
import { Feed, SessionLog, parseLog } from "./log.js";
import { pyEquals, pyRoundN, pyStrip } from "./py.js";
import { SimBody } from "./simbody.js";

/** The lab shut down while a call was waiting for its tick. */
export class WorldClosed extends Error {
  constructor(message = "the lab is closed") {
    super(message);
    this.name = "WorldClosed";
  }
}

function normPerson(pos) {
  if (pos == null) return null;
  return [pyRoundN(Number(pos[0]), 2), pyRoundN(Number(pos[1]), 2)];
}

function normPin(pin, config) {
  if (pin == null) return null;
  const row = Math.trunc(Number(pin[0])) + 0;     // Python's int(); + 0 turns -0 into 0
  const col = Math.trunc(Number(pin[1])) + 0;
  if (row >= 0 && row < config.GRID_ROWS && col >= 0 && col < config.GRID_COLS) return [row, col];
  return null;
}

// Python's == between two (row, column) tuples or None.
function samePoint(a, b) {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

// Python's truthiness for a logged position or pin: null and [] are false.
const present = (x) => Array.isArray(x) ? x.length > 0 : Boolean(x);

export class World {
  constructor(config, log = null) {
    this.config = config;
    this.body = new SimBody(config);
    this.log = log ?? new SessionLog();
    this.feed = this.log.feed;
    // body -> mind, a FIFO the harness shifts: ["enter", t], ["leave", t], ["voice", t, text]
    this.events = [];
    // A label set by the harness; stamped on every logged body call.
    this.turn = 0;
    this._calls = [];
    this._person = null;
    this._pressed = null;
    this._started = false;
    this._closed = false;
  }

  get t() {
    return this.body.t;
  }

  get closed() {
    return this._closed;
  }

  /**
   * Advance the lab by one simulation tick.
   *
   * person   [row, column] in pin units, or null when nobody is there
   * pressed  [row, column] of the pin under a held mouse button, or null
   *
   * Order inside a tick: the person, then the mind's queued calls in arrival
   * order, then the body moves. The log records that order, which is what
   * makes a session replayable. Until someone first arrives nothing happens
   * and no time passes: the session begins with the arrival.
   */
  tick(person = null, pressed = null) {
    person = normPerson(person);
    if (!this._started) {
      if (person === null) return;
      this._started = true;
    }

    const { body, log } = this;
    const k = body.tick;
    const t = body.t;

    if (!samePoint(person, this._person)) {
      const arrived = this._person === null;
      const left = person === null;
      this._person = person;
      body.setPerson(person);
      log.write({ type: "person", tick: k, t, pos: person && [...person] });
      if (arrived) this.events.push(["enter", t]);
      else if (left) this.events.push(["leave", t]);
    }

    pressed = normPin(pressed, this.config);
    if (!samePoint(pressed, this._pressed)) {
      this._pressed = pressed;
      body.setPressed(pressed);
      log.write({ type: "press", tick: k, t, pin: pressed && [...pressed] });
    }

    while (this._calls.length > 0) {
      const { name, args, resolve } = this._calls.shift();
      const result = body.call(name, args);
      log.write({ type: "call", turn: this.turn, tick: k, t, name, args, result });
      resolve(result);
    }

    body.step();

    if (body.tick % this.config.STATE_EVERY_TICKS === 0) this._writeState();
  }

  /** The person's voice: one typed line. */
  say(text) {
    text = pyStrip(text);
    if (!text) return;
    const k = this.body.tick;
    const t = this.body.t;
    this.log.write({ type: "voice", tick: k, t, text });
    this.events.push(["voice", t, text]);
  }

  snapshot() {
    return this.body.snapshot();
  }

  /** Stop serving the mind. The body stays as it is. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._writeState();
    for (const { reject } of this._calls.splice(0)) reject(new WorldClosed());
  }

  _writeState() {
    this.log.write({ type: "state", tick: this.body.tick, t: this.body.t, hash: this.body.stateHash() });
  }

  /**
   * The body as the mind sees it. `call` returns a Promise: the call is
   * applied and logged on the next tick, which resolves it with the answer.
   * It rejects with WorldClosed if the world is closed, or closes first.
   */
  remoteBody() {
    return { call: (name, args = null) => this._submit(name, args) };
  }

  _submit(name, args) {
    if (this._closed) return Promise.reject(new WorldClosed());
    return new Promise((resolve, reject) => this._calls.push({ name, args, resolve, reject }));
  }
}

/**
 * Re-runs a logged session through a fresh body.
 *
 * Inputs (person, press, body calls) are applied at their recorded ticks.
 * Everything else in the log (voice, wakes, thoughts, turn ends) is fed to
 * `feed` as its time comes, so the page can show the session as it was.
 * Each replayed call is compared with its logged result and each `state` line
 * with the body's checksum; differences collect in `mismatches`.
 */
export class ReplayWorld {
  constructor(events) {
    const header = events.find((e) => e?.type === "header");
    if (header === undefined) throw new Error("not a session log: no header line");
    this.header = header;
    this.config = Config.fromDict(header.config ?? {});
    this.body = new SimBody(this.config);
    this.feed = new Feed();
    this.feed.append(header);
    this.mismatches = [];
    this.callsReplayed = 0;
    this.statesChecked = 0;

    this._inputs = new Map();     // tick -> events
    this._states = new Map();     // tick -> hash
    this._story = [];
    this._storyI = 0;
    let end = 0;
    for (const ev of events) {
      const kind = ev.type;
      if (kind === "header") continue;
      let tick = ev.tick ?? null;
      if (tick === null) tick = this.config.tickOf(Object.hasOwn(ev, "t") ? ev.t : 0.0);
      end = Math.max(end, tick);
      if (kind === "state") {
        this._states.set(ev.tick, ev.hash);
      } else if (kind === "person" || kind === "press" || (kind === "call" && Object.hasOwn(ev, "tick"))) {
        if (!this._inputs.has(ev.tick)) this._inputs.set(ev.tick, []);
        this._inputs.get(ev.tick).push(ev);
      } else {
        this._story.push(ev);
      }
    }
    this.endTick = end;
  }

  get t() {
    return this.body.t;
  }

  get done() {
    return this.body.tick >= this.endTick && this._storyI >= this._story.length;
  }

  /** One tick of the recorded session. Live inputs are ignored. */
  tick() {
    const body = this.body;
    const k = body.tick;
    for (const ev of this._inputs.get(k) ?? []) {
      if (ev.type === "person") {
        body.setPerson(present(ev.pos) ? [...ev.pos] : null);
      } else if (ev.type === "press") {
        body.setPressed(present(ev.pin) ? [...ev.pin] : null);
      } else {
        // Python compares after a JSON round trip; the answer here is
        // already plain JSON, and == treats 1 and 1.0 alike.
        const result = body.call(ev.name, ev.args);
        this.callsReplayed += 1;
        if (!pyEquals(result, ev.result ?? null)) {
          this.mismatches.push(`tick ${k}: \`${ev.name}\` answered differently in replay`);
        }
      }
      this.feed.append(ev);
    }

    const now = body.t + 1e-9;
    while (this._storyI < this._story.length && storyTime(this._story[this._storyI]) <= now) {
      this.feed.append(this._story[this._storyI]);
      this._storyI += 1;
    }

    body.step();

    const expected = this._states.get(body.tick);
    if (expected != null) {
      this.statesChecked += 1;
      if (body.stateHash() !== expected) {
        this.mismatches.push(`tick ${body.tick}: body state differs from the log`);
      }
    }
  }

  say() {}

  snapshot() {
    return this.body.snapshot();
  }

  close() {}
}

// Python reads a missing `t` as 0.0 (and fails on anything else that is not
// a number). Here anything that is not a number counts as 0.0, so a damaged
// log dropped on the page can never stall the replay.
function storyTime(ev) {
  return typeof ev.t === "number" && !Number.isNaN(ev.t) ? ev.t : 0.0;
}

/** Replay a session headlessly and report whether the body matched. */
export function verifyLog(events) {
  const world = new ReplayWorld(typeof events === "string" ? parseLog(events) : events);
  while (!world.done) world.tick();
  return {
    ok: world.mismatches.length === 0,
    ticks: world.body.tick,
    seconds: world.body.t,
    calls: world.callsReplayed,
    states: world.statesChecked,
    mismatches: world.mismatches,
  };
}
