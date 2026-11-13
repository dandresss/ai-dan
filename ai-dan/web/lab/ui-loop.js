// The page's clock, the person's pointer and what a key does in the room,
// as plain logic (no DOM), so tests can drive them.

export const STEP_S = 0.02;          // one simulation tick
export const MAX_CATCH_UP = 10;      // ticks per frame at most; a longer stall is dropped, not replayed
// A hidden tab gets no animation frames, and its timers are woken rarely:
// about once a second, and in Chrome about once a minute after five minutes
// hidden. Each wake catches simulation time up with the wall clock, up to a
// minute (3000 steps of 64 pins are cheap), so the mind's absence and its
// limits are counted in real seconds; a longer gap is dropped like any stall.
export const HIDDEN_CATCH_UP = 3000;

/**
 * The fixed-step loop of app.py: simulation time runs in 20 ms steps kept in
 * line with the wall clock. Call `frame(now, step)` once per drawn frame.
 */
export class FixedStep {
  constructor({ stepS = STEP_S } = {}) {
    this.stepS = stepS;
    this.backlog = 0;
    this.last = null;
  }

  /** Forget the time that has passed, as after a pause of the page. */
  reset(now) {
    this.backlog = 0;
    this.last = now;
  }

  /**
   * `now` is wall-clock seconds. `step()` runs one tick, or returns false
   * when there is nothing left to run (a replay at its end). Returns the
   * number of ticks run and the wall-clock time since the last frame.
   */
  frame(now, step, { speed = 1, paused = false, maxCatchUp = MAX_CATCH_UP } = {}) {
    const dt = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    if (!paused) this.backlog += dt * speed;
    const cap = maxCatchUp * Math.max(1, Math.ceil(speed));
    let steps = 0;
    while (this.backlog >= this.stepS && steps < cap) {
      if (step() === false) {
        this.backlog = 0;
        break;
      }
      this.backlog -= this.stepS;
      steps += 1;
    }
    if (steps >= cap) this.backlog = Math.min(this.backlog, this.stepS);
    return { steps, dt };
  }
}

/**
 * The person, as the pointer says. With a mouse (or a pen that hovers) the
 * person is in the room while the pointer is in the window, and touches while
 * the primary button is held. On a touch screen a finger down is presence
 * and touch; lifting it is leaving.
 */
export class Pointer {
  constructor() {
    this.pos = null;          // [x, y] in CSS px, while the person is in the room
    this.button = false;
    this.arrived = false;
    this.touch = false;       // the last pointer was a finger
    this._finger = false;
  }

  move(x, y, type) {
    if (type === "touch") {
      if (!this._finger) return;
    } else {
      this.touch = false;
    }
    this.pos = [x, y];
    this.arrived = true;
  }

  down(x, y, type) {
    this.touch = type === "touch";
    this._finger = this.touch;
    this.pos = [x, y];
    this.button = true;
    this.arrived = true;
  }

  up(type) {
    this.button = false;
    if (type === "touch" && this._finger) {
      this._finger = false;
      this.pos = null;
    }
  }

  /** The pointer left the window, or the tab was hidden. */
  leave() {
    this.pos = null;
    this.button = false;
    this._finger = false;
  }

  /** [row, column] in pin units, or null when nobody is there. */
  person(lay) {
    return this.pos ? lay.toPinUnits(this.pos) : null;
  }

  /** The pin under a held button or finger, or null. */
  pressed(lay, rows = 8, cols = 8) {
    return this.pos && this.button ? lay.pinAt(this.pos, rows, cols) : null;
  }
}

/**
 * What a key does in the room: "panel", "help", "clean", "close-help",
 * "pause", "type" (move to the typing line), or null (the browser's own).
 * Letters are never shortcuts: typing is the person's voice. Tab opens the
 * observer, as on the desktop, unless a button has focus: then Tab and
 * Shift+Tab move between the buttons, and Shift+Tab is how the keyboard
 * reaches them.
 */
export function keyAction({ key, shift = false, ctrl = false, alt = false, meta = false,
  onControl = false, replay = false, typing = false, helpOpen = false }) {
  const plain = !ctrl && !alt && !meta;
  if (key === "F1") return "help";
  if (key === "F2") return "clean";
  if (key === "Escape") return helpOpen ? "close-help" : null;
  if (key === "Tab") return plain && !shift && !onControl ? "panel" : null;
  if (onControl && (key === " " || key === "Enter")) return null;   // the button's own
  if (replay) return key === " " && plain ? "pause" : null;
  if (plain && !typing && (key.length === 1 || key === "Process")) return "type";
  return null;
}
