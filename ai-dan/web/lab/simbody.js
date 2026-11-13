// SimBody: the simulated body. Contract on the outside, nervous system and
// shape display on the inside. Single-threaded and deterministic.
// A port of lab/simbody.py.

import { Contract } from "./contract.js";
import { Display } from "./display.js";
import { NervousSystem } from "./nervous.js";
import { floatRepr, pyRoundN, sha256Hex } from "./py.js";

export class SimBody {
  constructor(config) {
    this.config = config;
    this.tick = 0;                       // completed steps
    this.nervous = new NervousSystem(config);
    this.display = new Display(config);
    this.contract = new Contract(config, this.nervous, this.display);
  }

  get t() {
    return this.config.timeOf(this.tick);
  }

  setPerson(pos) {
    this.display.person = pos == null ? null : [pos[0], pos[1]];
  }

  setPressed(pin) {
    this.display.pressed = pin == null ? null : [pin[0], pin[1]];
  }

  /** The contract. Never throws on bad input: it answers with the error shape. */
  call(name, args = null) {
    return this.contract.call(name, args, this.tick);
  }

  /** Ordered heights for the current time, handed to the display; then time moves on. */
  step() {
    this.display.step(this.nervous.heights(this.tick / this.config.TICK_HZ));
    this.tick += 1;
  }

  snapshot() {
    return this.display.snapshot(this.tick, this.t);
  }

  /**
   * The first 16 hex digits of the SHA-256 of
   * json.dumps(_rounded([tick, display.state(), nervous.state()])), as Python
   * computes it. Every field's Python type is known here: tick, colour and the
   * pushed pin are ints, `loop` a bool, `ease` a string, every other number a
   * float rounded to 9 decimals.
   */
  stateHash() {
    const [target, actual, gapMax, delayLine, color, pressed, person] = this.display.state();
    const display = list([
      floats(target), floats(actual), floats(gapMax), list(delayLine.map(floats)),
      ints(color), pressed === null ? "null" : ints(pressed), person === null ? "null" : floats(person),
    ]);
    const nervous = list(this.nervous.state().map(([keyframes, loop, ease, tStart, hold]) => list([
      keyframes === null ? "null" : list(keyframes.map(floats)),
      loop ? "true" : "false", JSON.stringify(ease), float(tStart), float(hold),
    ])));
    return sha256Hex(list([String(this.tick), display, nervous])).slice(0, 16);
  }
}

const list = (items) => `[${items.join(", ")}]`;
const float = (x) => floatRepr(pyRoundN(x, 9));   // floats to 9 decimals, as `_rounded` does
const floats = (xs) => list(xs.map(float));
const ints = (xs) => list(xs.map(String));
