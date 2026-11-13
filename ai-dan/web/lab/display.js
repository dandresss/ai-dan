// The shape display: 64 pins that follow orders late, slowly and imperfectly.
// A port of lab/display.py.

import { pyMax, pyMin, pyRound, pyRoundN } from "./py.js";

export class Display {
  constructor(config) {
    this.config = config;
    const n = config.nPins;
    this.target = new Array(n).fill(0.0);   // latest ordered heights, quantized on arrival
    this.actual = new Array(n).fill(0.0);   // real heights, continuous
    this.gapMax = new Array(n).fill(0.0);   // deviation trace since the last sense
    // Past targets; the oldest is the one the actuator is following now.
    this.delayLength = config.responseTicks + 1;
    this.delayLine = new Array(this.delayLength).fill(this.target);
    this.color = [...config.DEFAULT_COLOR];
    this.person = null;                     // [row, column] in pin units, or null
    this.pressed = null;                    // [row, column] of the pushed pin, or null
  }

  /** One tick: take the ordered heights, move every pin, update the trace. */
  step(ordered) {
    const top = this.config.LEVELS - 1;
    this.target = ordered.map((h) => pyRound(pyMin(pyMax(h, 0.0), 1.0) * top) / top);
    this.delayLine.push(this.target);
    while (this.delayLine.length > this.delayLength) this.delayLine.shift();
    const following = this.delayLine[0];
    const limit = this.config.maxStep;
    const pushed = this._index(this.pressed);
    for (let i = 0; i < this.config.nPins; i++) {
      const goal = i === pushed ? 0.0 : following[i];
      let a = this.actual[i];
      if (Math.abs(goal - a) <= limit) a = goal;
      else a += goal > a ? limit : -limit;
      this.actual[i] = a;
      this.gapMax[i] = pyMax(this.gapMax[i], Math.abs(this.target[i] - a));
    }
  }

  /** Reported state, without the time. Reading resets the trace. */
  sense() {
    const top = this.config.LEVELS - 1;
    const actual = this.actual.map((a) => pyRoundN(pyRound(a * top) / top, 2));
    const gap = this.gapMax.map((g) => pyRoundN(g, 2));
    this.gapMax = new Array(this.config.nPins).fill(0.0);
    const person = this.person === null
      ? null
      : [pyRoundN(this.person[0], 1), pyRoundN(this.person[1], 1)];
    return { actual: this._matrix(actual), gap: this._matrix(gap), person, color: [...this.color] };
  }

  /** For the lab: never resets the trace. */
  snapshot(tick, t) {
    return {
      tick, t,
      rows: this.config.GRID_ROWS, cols: this.config.GRID_COLS,
      target: this._matrix(this.target), actual: this._matrix(this.actual),
      gap_max: this._matrix(this.gapMax), color: [...this.color],
      person: this.person && [...this.person], pressed: this.pressed && [...this.pressed],
    };
  }

  state() {
    return [this.target, this.actual, this.gapMax, [...this.delayLine],
      this.color, this.pressed, this.person];
  }

  _index(pin) {
    return pin === null ? null : pin[0] * this.config.GRID_COLS + pin[1];
  }

  _matrix(flat) {
    const cols = this.config.GRID_COLS;
    return Array.from({ length: this.config.GRID_ROWS }, (_, r) => flat.slice(r * cols, (r + 1) * cols));
  }
}
