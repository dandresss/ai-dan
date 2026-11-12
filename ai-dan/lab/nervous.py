"""The nervous system: sparse orders in, 64 ordered heights out, every tick.

Plain loops over 64 pins on purpose: this is meant to be ported to the
Arduino firmware. It trusts its input; validation lives in `contract.py`.
"""
from __future__ import annotations

import math

from .config import Config


class Pin:
    """One pin's state. It owns its keyframes: there is no shared track pool."""

    def __init__(self):
        self.keyframes = None   # [(second, height), ...] or None when there is no track
        self.loop = False
        self.ease = "smooth"
        self.t_start = 0.0      # arrival time plus delay_s
        self.hold = 0.0         # height kept with no track, while waiting, or after finishing

    def ordered(self, t: float) -> float:
        if self.keyframes is None:
            return self.hold
        tau = t - self.t_start
        if tau < 0:
            return self.hold
        kf = self.keyframes
        duration = kf[-1][0]
        if self.loop:
            tau = tau % duration
        elif tau >= duration:
            self.hold = kf[-1][1]
            self.keyframes = None       # finished: release the track
            return self.hold
        i = 0
        while i < len(kf) - 2 and tau >= kf[i + 1][0]:
            i += 1
        (t0, h0), (t1, h1) = kf[i], kf[i + 1]
        u = (tau - t0) / (t1 - t0)
        if self.ease == "smooth":
            u = (1 - math.cos(math.pi * u)) / 2
        return h0 + (h1 - h0) * u

    def state(self) -> list:
        return [self.keyframes, self.loop, self.ease, self.t_start, self.hold]


class NervousSystem:
    def __init__(self, config: Config):
        self.pins = [Pin() for _ in range(config.n_pins)]

    def heights(self, t: float) -> list:
        """The 64 ordered heights at time t, in pin-index order (row * cols + col)."""
        return [pin.ordered(t) for pin in self.pins]

    def play(self, tracks: list, now: float) -> None:
        """tracks: dicts with `pins` (indices), `keyframes`, `loop`, `ease`, `delay_s`."""
        # A pin named in several tracks of one call follows the last one. Settle
        # that first, so its hold is the height it had when the call arrived and
        # not the first keyframe of a track it never follows.
        final = {}
        for track in tracks:
            for i in track["pins"]:
                final[i] = track
        for i, track in final.items():
            pin = self.pins[i]
            pin.hold = pin.ordered(now)       # keep where it is until the track starts
            pin.keyframes = list(track["keyframes"])
            pin.loop = track["loop"]
            pin.ease = track["ease"]
            pin.t_start = now + track["delay_s"]

    def stop(self, pins: list, now: float) -> None:
        for i in pins:
            pin = self.pins[i]
            pin.hold = pin.ordered(now)
            pin.keyframes = None

    def state(self) -> list:
        return [pin.state() for pin in self.pins]
