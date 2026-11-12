"""The four tools: validation of raw model input, behaviour, return shapes.

Input comes straight from a language model, so anything can arrive. Every
check runs before anything changes: a rejected call leaves the body untouched.
"""
from __future__ import annotations

import math

from .config import Config
from .display import Display
from .nervous import NervousSystem

NO_POINT = "That point does not exist in your body."
TOO_MANY = "That is too many movements at once."
TOO_LONG = "That movement is too long to remember."
BAD_MOVEMENT = "That movement cannot be understood."
BAD_COLOR = "That color cannot be understood."
BAD_CALL = "That cannot be understood."


class Rejected(Exception):
    """A call the body refuses; the message is what the agent reads."""


def _number(x) -> float | None:
    """A finite real number (not a boolean), else None."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    try:
        x = float(x)
    except OverflowError:
        return None
    return x if math.isfinite(x) else None


def _integer(x) -> int | None:
    """An integer, or a float with an integral value such as 2.0."""
    v = _number(x)
    return int(v) if v is not None and v == int(v) else None


def _pair(x) -> bool:
    return isinstance(x, (list, tuple)) and len(x) == 2


class Contract:
    def __init__(self, config: Config, nervous: NervousSystem, display: Display):
        self.config = config
        self.nervous = nervous
        self.display = display

    def call(self, name, args, tick: int) -> dict:
        t = self.config.time_of(tick)
        try:
            if name == "play":
                self._play(args, tick)
            elif name == "stop":
                self._stop(args, tick)
            elif name == "set_color":
                self._set_color(args)
            elif name == "sense":
                return {"t": t, **self.display.sense()}
            else:
                raise Rejected(BAD_CALL)
        except Rejected as error:
            return {"ok": False, "t": t, "error": str(error)}
        return {"ok": True, "t": t}

    # --- tools ------------------------------------------------------------
    def _play(self, args, tick: int) -> None:
        raw = args.get("tracks") if isinstance(args, dict) else None
        if not isinstance(raw, list) or not raw:
            raise Rejected(BAD_MOVEMENT)
        if len(raw) > self.config.MAX_TRACKS:
            raise Rejected(TOO_MANY)
        tracks = [self._track(item) for item in raw]
        self.nervous.play(tracks, tick / self.config.TICK_HZ)

    def _stop(self, args, tick: int) -> None:
        if args is not None and not isinstance(args, dict):
            raise Rejected(BAD_MOVEMENT)
        pins = self._pins(args.get("pins") if args else None, default_all=True)
        self.nervous.stop(pins, tick / self.config.TICK_HZ)

    def _set_color(self, args) -> None:
        rgb = args.get("rgb") if isinstance(args, dict) else None
        if not isinstance(rgb, (list, tuple)) or len(rgb) != 3:
            raise Rejected(BAD_COLOR)
        values = [_integer(c) for c in rgb]
        if any(v is None or not 0 <= v <= 255 for v in values):
            raise Rejected(BAD_COLOR)
        self.display.color = tuple(values)

    # --- validation -------------------------------------------------------
    def _pins(self, pins, default_all=False) -> list:
        """Pin indices (row * cols + col) from "all" or a list of [row, column]."""
        rows, cols = self.config.GRID_ROWS, self.config.GRID_COLS
        if pins == "all" or (pins is None and default_all):
            return list(range(rows * cols))
        if not isinstance(pins, list) or not pins:
            raise Rejected(BAD_MOVEMENT)
        points = []
        for pair in pins:
            if not _pair(pair):
                raise Rejected(BAD_MOVEMENT)
            row, col = _integer(pair[0]), _integer(pair[1])
            if row is None or col is None:
                raise Rejected(BAD_MOVEMENT)
            points.append((row, col))
        if any(not (0 <= r < rows and 0 <= c < cols) for r, c in points):
            raise Rejected(NO_POINT)
        return [r * cols + c for r, c in points]

    def _track(self, raw) -> dict:
        if not isinstance(raw, dict):
            raise Rejected(BAD_MOVEMENT)
        pins = self._pins(raw.get("pins"))
        keyframes = self._keyframes(raw.get("keyframes"))

        loop = raw.get("loop")
        loop = False if loop is None else loop
        ease = raw.get("ease")
        ease = "smooth" if ease is None else ease
        delay = raw.get("delay_s")
        delay = 0.0 if delay is None else _number(delay)
        if not isinstance(loop, bool) or ease not in ("smooth", "linear") or delay is None or delay < 0:
            raise Rejected(BAD_MOVEMENT)
        if delay > self.config.MAX_TRACK_S:
            raise Rejected(TOO_LONG)
        return {"pins": pins, "keyframes": keyframes, "loop": loop, "ease": ease, "delay_s": delay}

    def _keyframes(self, raw) -> list:
        if not isinstance(raw, list):
            raise Rejected(BAD_MOVEMENT)
        if len(raw) > self.config.MAX_KEYFRAMES:
            raise Rejected(TOO_LONG)
        frames = []
        for item in raw:
            second = _number(item[0]) if _pair(item) else None
            height = _number(item[1]) if _pair(item) else None
            if second is None or height is None:
                raise Rejected(BAD_MOVEMENT)
            frames.append((second, min(max(height, 0.0), 1.0)))   # out of range is clipped, not an error
        if any(second > self.config.MAX_TRACK_S for second, _ in frames):
            raise Rejected(TOO_LONG)
        times = [second for second, _ in frames]
        if len(frames) < 2 or times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])):
            raise Rejected(BAD_MOVEMENT)
        return frames
