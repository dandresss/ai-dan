// The nervous system: sparse orders in, 64 ordered heights out, every tick.
// A port of lab/nervous.py. It trusts its input; validation lives in contract.js.

/** One pin's state. It owns its keyframes: there is no shared track pool. */
export class Pin {
  constructor() {
    this.keyframes = null;   // [[second, height], ...] or null when there is no track
    this.loop = false;
    this.ease = "smooth";
    this.tStart = 0.0;       // arrival time plus delay_s
    this.hold = 0.0;         // height kept with no track, while waiting, or after finishing
  }

  ordered(t) {
    if (this.keyframes === null) return this.hold;
    let tau = t - this.tStart;
    if (tau < 0) return this.hold;
    const kf = this.keyframes;
    const duration = kf[kf.length - 1][0];
    if (this.loop) {
      tau = tau % duration;            // both positive: same as Python's float %
    } else if (tau >= duration) {
      this.hold = kf[kf.length - 1][1];
      this.keyframes = null;           // finished: release the track
      return this.hold;
    }
    let i = 0;
    while (i < kf.length - 2 && tau >= kf[i + 1][0]) i += 1;
    const [t0, h0] = kf[i];
    const [t1, h1] = kf[i + 1];
    let u = (tau - t0) / (t1 - t0);
    if (this.ease === "smooth") u = (1 - Math.cos(Math.PI * u)) / 2;
    return h0 + (h1 - h0) * u;
  }

  state() {
    return [this.keyframes, this.loop, this.ease, this.tStart, this.hold];
  }
}

export class NervousSystem {
  constructor(config) {
    this.pins = Array.from({ length: config.nPins }, () => new Pin());
  }

  /** The 64 ordered heights at time t, in pin-index order (row * cols + col). */
  heights(t) {
    return this.pins.map((pin) => pin.ordered(t));
  }

  /** tracks: objects with `pins` (indices), `keyframes`, `loop`, `ease`, `delay_s`. */
  play(tracks, now) {
    // A pin named in several tracks of one call follows the last one. Settle
    // that first, so its hold is the height it had when the call arrived and
    // not the first keyframe of a track it never follows.
    const final = new Map();
    for (const track of tracks) {
      for (const i of track.pins) final.set(i, track);
    }
    for (const [i, track] of final) {
      const pin = this.pins[i];
      pin.hold = pin.ordered(now);     // keep where it is until the track starts
      pin.keyframes = [...track.keyframes];
      pin.loop = track.loop;
      pin.ease = track.ease;
      pin.tStart = now + track.delay_s;
    }
  }

  stop(pins, now) {
    for (const i of pins) {
      const pin = this.pins[i];
      pin.hold = pin.ordered(now);
      pin.keyframes = null;
    }
  }

  state() {
    return this.pins.map((pin) => pin.state());
  }
}
