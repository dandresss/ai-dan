"""The seam between a mind and a body.

`Body` is everything the harness is allowed to know about a body: one method
that takes a tool name and its input and returns the contract's answer. The
simulator implements it today (`lab.simbody.SimBody`); the board will later.
"""
from __future__ import annotations

from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Callable, Protocol

BODY_TOOLS = ("play", "stop", "sense", "set_color")


class Body(Protocol):
    def call(self, name: str, args: dict | None = None) -> dict:
        """Run one contract tool. Never raises on bad input: it returns the
        contract's error shape instead."""
        ...


class WorldClosed(Exception):
    """The lab shut down while a call was waiting for its tick."""


@dataclass(frozen=True)
class Snapshot:
    """What the lab can see of the body. Reading it never resets the trace.

    Matrices are indexed [row][column], with (0, 0) at the top left.
    """
    tick: int
    t: float
    rows: int
    cols: int
    target: list   # ordered heights, 0..1 (already quantized on arrival)
    actual: list   # real heights, 0..1, continuous
    gap_max: list  # deviation trace since the agent's last `sense`
    color: tuple   # (r, g, b)
    person: tuple | None   # (row, column) in pin units; None when nobody is there
    pressed: tuple | None  # (row, column) of the pin being pushed, if any


class ThreadedBody:
    """The body as seen from the mind thread.

    A call is queued, applied by the main thread on its next tick, and the
    answer comes back here. The body never waits for the mind; the mind waits
    at most one tick for the body.
    """

    def __init__(self, submit: Callable[[str, dict | None], Future],
                 is_closed: Callable[[], bool]):
        self._submit = submit
        self._is_closed = is_closed

    def call(self, name: str, args: dict | None = None) -> dict:
        future = self._submit(name, args)
        while True:
            try:
                return future.result(timeout=0.25)
            except FutureTimeout:
                if self._is_closed():
                    raise WorldClosed() from None
