// Every parameter from every spec, in one place: a port of lab/config.py.
//
// Same names, same defaults, same order. The session log header records the
// whole table, so the order shows in every log.

import { pyRound, pyRoundN } from "./py.js";

export const DEFAULTS = Object.freeze({
  // --- shape-display.md
  GRID_ROWS: 8,
  GRID_COLS: 8,
  LEVELS: 64,                  // distinguishable height levels
  FULL_TRAVEL_S: 0.5,          // seconds to travel from 0 to 1
  TICK_HZ: 50,                 // simulation ticks per second
  RESPONSE_MS: 80,             // actuator response delay
  DEFAULT_COLOR: Object.freeze([255, 255, 255]),

  // --- body-contract.md (internal caps, never shown to the agent)
  MAX_TRACKS: 16,
  MAX_KEYFRAMES: 16,
  MAX_TRACK_S: 600.0,

  // --- harness.md
  PULSE_S: 12.0,               // seconds between wakes while someone is present
  ABSENCE_GRACE_S: 2.0,
  MAX_TOOL_CALLS: 8,           // per turn
  MAX_TURNS: 40,               // per session
  MAX_SESSION_MIN: 15.0,
  MEMORY_FULL_TURNS: 6,        // recent turns kept in full
  MAX_TOKENS: 4096,
  MODEL: "claude-sonnet-5-5",
  EFFORT: "low",               // low | medium | high | xhigh | max
  THINKING: "adaptive",        // adaptive | between_tools

  // --- mind.md
  PROMPT_VERSION: "mind-v0",
  LANGUAGE: "en",
  MEMORY_ENABLED: false,       // false = first-day mode: no `remember`, no note
  NOTE_MAX_CHARS: 1500,

  // --- lab bookkeeping (not in the specs)
  STATE_EVERY_TICKS: 250,      // a body-state checksum goes to the log this often
});

const copy = (value) => (Array.isArray(value) ? [...value] : value);

export class Config {
  constructor(overrides = {}) {
    for (const [name, value] of Object.entries(DEFAULTS)) this[name] = copy(value);
    for (const [name, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(DEFAULTS, name)) throw new TypeError(`Config has no field ${name}`);
      this[name] = copy(value);
    }
  }

  // --- derived
  get nPins() {
    return this.GRID_ROWS * this.GRID_COLS;
  }

  /** Largest height change per tick: 0.04 with the defaults. */
  get maxStep() {
    return 1.0 / (this.FULL_TRAVEL_S * this.TICK_HZ);
  }

  /** Actuator response delay in whole ticks: 4 with the defaults. */
  get responseTicks() {
    return pyRound(this.RESPONSE_MS * this.TICK_HZ / 1000);
  }

  /** Simulation seconds at a tick, as reported everywhere (two decimals). */
  timeOf(tick) {
    return pyRoundN(tick / this.TICK_HZ, 2);
  }

  tickOf(t) {
    return pyRound(t * this.TICK_HZ);
  }

  // --- (de)serialisation
  toDict() {
    const out = {};
    for (const name of Object.keys(DEFAULTS)) out[name] = copy(this[name]);
    return out;
  }

  static fromDict(data) {
    const config = new Config();
    for (const name of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(data, name)) config[name] = copy(data[name]);
    }
    return config;
  }
}
