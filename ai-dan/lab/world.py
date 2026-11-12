"""The lab's main-thread glue: one body, one log, two queues.

World        the live lab. The window calls `tick()` 50 times a second; the
             mind thread reaches the body through `remote_body()`.
ReplayWorld  the same surface, fed from a session log instead of a person and
             a mind. No API calls, same body states.
"""
from __future__ import annotations

import json
import queue
from collections import defaultdict
from concurrent.futures import Future
from pathlib import Path

from .body import Snapshot, ThreadedBody, WorldClosed
from .config import Config
from .log import Feed, SessionLog, read_log
from .simbody import SimBody


def _norm_person(pos) -> tuple | None:
    if pos is None:
        return None
    return (round(float(pos[0]), 2), round(float(pos[1]), 2))


def _norm_pin(pin, config: Config) -> tuple | None:
    if pin is None:
        return None
    row, col = int(pin[0]), int(pin[1])
    if 0 <= row < config.GRID_ROWS and 0 <= col < config.GRID_COLS:
        return (row, col)
    return None


class World:
    def __init__(self, config: Config, log: SessionLog | None = None):
        self.config = config
        self.body = SimBody(config)
        self.log = log if log is not None else SessionLog(None)
        self.feed: Feed = self.log.feed
        # body -> mind: ("enter", t), ("leave", t), ("voice", t, text)
        self.events: queue.Queue = queue.Queue()
        # A label set by the harness; stamped on every logged body call.
        self.turn = 0
        self._calls: queue.SimpleQueue = queue.SimpleQueue()
        self._person = None
        self._pressed = None
        self._started = False
        self._closed = False

    # --- main thread ------------------------------------------------------
    @property
    def t(self) -> float:
        return self.body.t

    @property
    def closed(self) -> bool:
        return self._closed

    def tick(self, person=None, pressed=None) -> None:
        """Advance the lab by one simulation tick.

        person   (row, column) in pin units, or None when nobody is there
        pressed  (row, column) of the pin under a held mouse button, or None

        Order inside a tick: the person, then the mind's queued calls in
        arrival order, then the body moves. The log records that order, which
        is what makes a session replayable.

        Until someone first arrives nothing happens and no time passes: the
        session begins with the arrival, so `t` is seconds since then.
        """
        person = _norm_person(person)
        if not self._started:
            if person is None:
                return
            self._started = True

        body, log = self.body, self.log
        k, t = body.tick, body.t

        if person != self._person:
            arrived, left = self._person is None, person is None
            self._person = person
            body.set_person(person)
            log.write({"type": "person", "tick": k, "t": t,
                       "pos": list(person) if person else None})
            if arrived:
                self.events.put(("enter", t))
            elif left:
                self.events.put(("leave", t))

        pressed = _norm_pin(pressed, self.config)
        if pressed != self._pressed:
            self._pressed = pressed
            body.set_pressed(pressed)
            log.write({"type": "press", "tick": k, "t": t,
                       "pin": list(pressed) if pressed else None})

        while True:
            try:
                name, args, future = self._calls.get_nowait()
            except queue.Empty:
                break
            result = body.call(name, args)
            log.write({"type": "call", "turn": self.turn, "tick": k, "t": t,
                       "name": name, "args": args, "result": result})
            future.set_result(result)

        body.step()

        if body.tick % self.config.STATE_EVERY_TICKS == 0:
            self._write_state()

    def say(self, text: str) -> None:
        """The person's voice: one typed line."""
        text = text.strip()
        if not text:
            return
        k, t = self.body.tick, self.body.t
        self.log.write({"type": "voice", "tick": k, "t": t, "text": text})
        self.events.put(("voice", t, text))

    def snapshot(self) -> Snapshot:
        return self.body.snapshot()

    def close(self) -> None:
        """Stop serving the mind. The body stays as it is."""
        if self._closed:
            return
        self._closed = True
        self._write_state()
        while True:
            try:
                _, _, future = self._calls.get_nowait()
            except queue.Empty:
                break
            future.set_exception(WorldClosed())

    def _write_state(self) -> None:
        self.log.write({"type": "state", "tick": self.body.tick, "t": self.body.t,
                        "hash": self.body.state_hash()})

    # --- mind thread ------------------------------------------------------
    def remote_body(self) -> ThreadedBody:
        return ThreadedBody(self._submit, lambda: self._closed)

    def _submit(self, name: str, args: dict | None) -> Future:
        if self._closed:
            raise WorldClosed()
        future: Future = Future()
        self._calls.put((name, args, future))
        return future


class ReplayWorld:
    """Re-runs a logged session through a fresh body.

    Inputs (person, press, body calls) are applied at their recorded ticks.
    Everything else in the log (voice, wakes, thoughts, turn ends) is fed to
    `feed` as its time comes, so the window can show the session as it was.
    Each replayed call is compared with its logged result and each `state`
    line with the body's checksum; differences collect in `mismatches`.
    """

    def __init__(self, events: list[dict]):
        header = next((e for e in events if e.get("type") == "header"), None)
        if header is None:
            raise ValueError("not a session log: no header line")
        self.header = header
        self.config = Config.from_dict(header.get("config", {}))
        self.body = SimBody(self.config)
        self.feed = Feed()
        self.feed.append(header)
        self.mismatches: list[str] = []
        self.calls_replayed = 0
        self.states_checked = 0

        self._inputs: dict[int, list[dict]] = defaultdict(list)
        self._states: dict[int, str] = {}
        self._story: list[dict] = []
        self._story_i = 0
        end = 0
        for ev in events:
            kind = ev.get("type")
            if kind == "header":
                continue
            tick = ev.get("tick")
            if tick is None:
                tick = self.config.tick_of(ev.get("t", 0.0))
            end = max(end, tick)
            if kind == "state":
                self._states[ev["tick"]] = ev["hash"]
            elif kind in ("person", "press") or (kind == "call" and "tick" in ev):
                self._inputs[ev["tick"]].append(ev)
            else:
                self._story.append(ev)
        self.end_tick = end

    @property
    def t(self) -> float:
        return self.body.t

    @property
    def done(self) -> bool:
        return self.body.tick >= self.end_tick and self._story_i >= len(self._story)

    def tick(self, person=None, pressed=None) -> None:
        """One tick of the recorded session. Live inputs are ignored."""
        body = self.body
        k = body.tick
        for ev in self._inputs.get(k, ()):
            kind = ev["type"]
            if kind == "person":
                body.set_person(tuple(ev["pos"]) if ev["pos"] else None)
            elif kind == "press":
                body.set_pressed(tuple(ev["pin"]) if ev["pin"] else None)
            else:
                result = json.loads(json.dumps(body.call(ev["name"], ev["args"]), default=str))
                self.calls_replayed += 1
                if result != ev.get("result"):
                    self.mismatches.append(
                        f"tick {k}: `{ev['name']}` answered differently in replay")
            self.feed.append(ev)

        now = body.t + 1e-9
        while self._story_i < len(self._story) and self._story[self._story_i].get("t", 0.0) <= now:
            self.feed.append(self._story[self._story_i])
            self._story_i += 1

        body.step()

        expected = self._states.get(body.tick)
        if expected is not None:
            self.states_checked += 1
            if body.state_hash() != expected:
                self.mismatches.append(f"tick {body.tick}: body state differs from the log")

    def say(self, text: str) -> None:
        pass

    def snapshot(self) -> Snapshot:
        return self.body.snapshot()

    def close(self) -> None:
        pass


def verify_log(path: Path | str) -> dict:
    """Replay a session headlessly and report whether the body matched."""
    world = ReplayWorld(read_log(path))
    while not world.done:
        world.tick()
    return {
        "ok": not world.mismatches,
        "ticks": world.body.tick,
        "seconds": world.body.t,
        "calls": world.calls_replayed,
        "states": world.states_checked,
        "mismatches": world.mismatches,
    }
