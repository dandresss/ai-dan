// One session on the page: a world, its log and mind if it has them, the view
// and the loop that ties them to the wall clock. Ports App.run from app.py
// and the shutdown order from lab/__main__.py. No DOM here: app.js wires it.

import { layout } from "./render.js";
import { FixedStep, HIDDEN_CATCH_UP, MAX_CATCH_UP, Pointer } from "./ui-loop.js";

const INTRO_FADE_S = 1.2;
const SAID_FADE_S = 4.0;
export const MAX_LINE = 200;

/** What the person typed, as the desktop keeps it: printable characters
 * only (Python's str.isprintable), at most MAX_LINE, stripped. */
export function cleanLine(text) {
  const kept = [...String(text)].filter((ch) => ch === " " || !/[\p{C}\p{Z}]/u.test(ch));
  return kept.slice(0, MAX_LINE).join("").trim();
}

export class Session {
  /**
   * kind   "replay", "live" or "dryrun"
   * world  World or ReplayWorld
   * log    SessionLog (live and dry run)
   * harness  the mind, or null when it could not start
   */
  constructor({ kind, world, view, log = null, harness = null, events = null, name = null }) {
    this.kind = kind;
    this.world = world;
    this.view = view;
    this.log = log;
    this.harness = harness;
    this.events = events;        // a replay's events, to watch it again
    this.name = name;
    this.stepper = new FixedStep();
    this.pointer = new Pointer();
    this.layout = layout({ width: 1280, height: 800, dpr: 1 }, false);
    this.halted = false;         // no more ticks: shut down, or broken
    this.downloaded = false;
    this.lastNow = null;
  }

  get replay() {
    return this.kind === "replay";
  }

  /** A live mind that has not been shut down: leaving the page loses it. */
  get running() {
    return this.kind === "live" && !this.halted;
  }

  /**
   * Run the ticks that are due at wall-clock `now` (seconds), then bring the
   * view up to date. `hidden` is a tab in the background, woken by a timer.
   */
  advance(now, { hidden = false } = {}) {
    const view = this.view;
    const world = this.world;
    const dt = this.lastNow === null ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    if (this.halted) {
      this.stepper.reset(now);
    } else {
      this.stepper.frame(now, () => this._tick(), {
        speed: this.replay ? view.speed : 1,
        paused: this.replay && view.paused,
        maxCatchUp: hidden ? HIDDEN_CATCH_UP : MAX_CATCH_UP,
      });
    }

    view.observer.read(world.feed);
    if (this.replay || this.pointer.arrived) view.intro = Math.max(0, view.intro - dt / INTRO_FADE_S);
    view.saidAlpha = Math.max(0, view.saidAlpha - dt / SAID_FADE_S);
    if (this.replay) {
      const end = Math.max(1, world.endTick);
      view.replayProgress = Math.min(1, world.body.tick / end);
      view.replayTotal = end / world.config.TICK_HZ;
      if (world.done && !view.replayCheck) {
        view.replayCheck = { mismatches: [...world.mismatches], states: world.statesChecked, calls: world.callsReplayed };
      }
    }
    const inRoom = !this.replay && !this.halted;
    view.cursor = inRoom ? this.pointer.pos : null;
    view.pressing = inRoom && this.pointer.button;
  }

  _tick() {
    const world = this.world;
    if (this.replay) {
      if (world.done) return false;
      world.tick();
      return true;
    }
    const { GRID_ROWS, GRID_COLS } = world.config;
    world.tick(this.pointer.person(this.layout), this.pointer.pressed(this.layout, GRID_ROWS, GRID_COLS));
    return true;
  }

  /** The person's voice: one line. Returns what was said, or "". */
  say(text) {
    const line = cleanLine(text);
    if (!line || this.replay || this.halted) return "";
    this.world.say(line);
    this.view.said = line;
    this.view.saidAlpha = 1.0;
    return line;
  }

  /**
   * End the session: the world first, so a call the mind is waiting on is
   * released at once; then the mind, which writes `close`; then the log.
   * The room stays on screen as it was left.
   */
  async shutdown() {
    if (this.halted) return;
    this.halted = true;
    let failure = null;
    try {
      this.world.close();
    } catch (err) {
      failure ??= err;
    }
    if (this.harness) {
      try {
        await this.harness.stop("window_closed");
      } catch (err) {
        failure ??= err;
      }
    }
    try {
      this.log?.close();
    } catch (err) {
      failure ??= err;
    }
    this.view.observer.read(this.world.feed);
    if (failure) throw failure;
  }
}
