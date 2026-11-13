// The four tools: validation of raw model input, behaviour, return shapes.
// A port of lab/contract.py.
//
// Input comes straight from a language model, so anything can arrive. Every
// check runs before anything changes: a rejected call leaves the body
// untouched. The checks run in Python's order, so the same input gets the
// same message.

import { pyMax, pyMin } from "./py.js";

export const NO_POINT = "That point does not exist in your body.";
export const TOO_MANY = "That is too many movements at once.";
export const TOO_LONG = "That movement is too long to remember.";
export const BAD_MOVEMENT = "That movement cannot be understood.";
export const BAD_COLOR = "That color cannot be understood.";
export const BAD_CALL = "That cannot be understood.";

/** A call the body refuses; the message is what the agent reads. */
class Rejected extends Error {}

/** A finite real number (not a boolean), else null. */
function number(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** An integer, or a number with an integral value such as 2.0. */
function integer(x) {
  const v = number(x);
  if (v === null || !Number.isInteger(v)) return null;
  return v === 0 ? 0 : v;                 // Python's int(-0.0) is 0
}

const isPair = (x) => Array.isArray(x) && x.length === 2;

// Python's isinstance(x, dict) for parsed JSON.
const isDict = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// Python's dict.get: a missing key and a JSON null are both None.
const get = (dict, key) => (Object.hasOwn(dict, key) ? dict[key] ?? null : null);

export class Contract {
  constructor(config, nervous, display) {
    this.config = config;
    this.nervous = nervous;
    this.display = display;
  }

  call(name, args, tick) {
    const t = this.config.timeOf(tick);
    try {
      if (name === "play") this._play(args, tick);
      else if (name === "stop") this._stop(args, tick);
      else if (name === "set_color") this._setColor(args);
      else if (name === "sense") return { t, ...this.display.sense() };
      else throw new Rejected(BAD_CALL);
    } catch (error) {
      if (error instanceof Rejected) return { ok: false, t, error: error.message };
      throw error;
    }
    return { ok: true, t };
  }

  // --- tools
  _play(args, tick) {
    const raw = isDict(args) ? get(args, "tracks") : null;
    if (!Array.isArray(raw) || raw.length === 0) throw new Rejected(BAD_MOVEMENT);
    if (raw.length > this.config.MAX_TRACKS) throw new Rejected(TOO_MANY);
    const tracks = raw.map((item) => this._track(item));
    this.nervous.play(tracks, tick / this.config.TICK_HZ);
  }

  _stop(args, tick) {
    args = args ?? null;
    if (args !== null && !isDict(args)) throw new Rejected(BAD_MOVEMENT);
    const pins = this._pins(args === null ? null : get(args, "pins"), true);
    this.nervous.stop(pins, tick / this.config.TICK_HZ);
  }

  _setColor(args) {
    const rgb = isDict(args) ? get(args, "rgb") : null;
    if (!Array.isArray(rgb) || rgb.length !== 3) throw new Rejected(BAD_COLOR);
    const values = rgb.map(integer);
    if (values.some((v) => v === null || !(v >= 0 && v <= 255))) throw new Rejected(BAD_COLOR);
    this.display.color = values;
  }

  // --- validation

  /** Pin indices (row * cols + col) from "all" or a list of [row, column]. */
  _pins(pins, defaultAll = false) {
    const rows = this.config.GRID_ROWS;
    const cols = this.config.GRID_COLS;
    if (pins === "all" || (pins === null && defaultAll)) {
      return Array.from({ length: rows * cols }, (_, i) => i);
    }
    if (!Array.isArray(pins) || pins.length === 0) throw new Rejected(BAD_MOVEMENT);
    const points = [];
    for (const pair of pins) {
      if (!isPair(pair)) throw new Rejected(BAD_MOVEMENT);
      const row = integer(pair[0]);
      const col = integer(pair[1]);
      if (row === null || col === null) throw new Rejected(BAD_MOVEMENT);
      points.push([row, col]);
    }
    if (points.some(([r, c]) => !(r >= 0 && r < rows && c >= 0 && c < cols))) {
      throw new Rejected(NO_POINT);
    }
    return points.map(([r, c]) => r * cols + c);
  }

  _track(raw) {
    if (!isDict(raw)) throw new Rejected(BAD_MOVEMENT);
    const pins = this._pins(get(raw, "pins"));
    const keyframes = this._keyframes(get(raw, "keyframes"));

    const loop = get(raw, "loop") ?? false;
    const ease = get(raw, "ease") ?? "smooth";
    const rawDelay = get(raw, "delay_s");
    const delay = rawDelay === null ? 0.0 : number(rawDelay);
    if (typeof loop !== "boolean" || (ease !== "smooth" && ease !== "linear")
        || delay === null || delay < 0) {
      throw new Rejected(BAD_MOVEMENT);
    }
    if (delay > this.config.MAX_TRACK_S) throw new Rejected(TOO_LONG);
    return { pins, keyframes, loop, ease, delay_s: delay };
  }

  _keyframes(raw) {
    if (!Array.isArray(raw)) throw new Rejected(BAD_MOVEMENT);
    if (raw.length > this.config.MAX_KEYFRAMES) throw new Rejected(TOO_LONG);
    const frames = [];
    for (const item of raw) {
      const second = isPair(item) ? number(item[0]) : null;
      const height = isPair(item) ? number(item[1]) : null;
      if (second === null || height === null) throw new Rejected(BAD_MOVEMENT);
      // Out of range is clipped, not an error.
      frames.push([second, pyMin(pyMax(height, 0.0), 1.0)]);
    }
    if (frames.some(([second]) => second > this.config.MAX_TRACK_S)) throw new Rejected(TOO_LONG);
    const times = frames.map(([second]) => second);
    if (frames.length < 2 || times[0] !== 0 || times.slice(1).some((b, i) => b <= times[i])) {
      throw new Rejected(BAD_MOVEMENT);
    }
    return frames;
  }
}
