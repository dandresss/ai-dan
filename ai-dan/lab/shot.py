"""Headless screenshots of canned scenes, for checking the drawing and for the README.

    python -m lab.shot <scene> <out.png> [--size 1280x800]
    python -m lab.shot all <directory>

Scenes are built by hand from `Snapshot` objects, so they need no body, no
mind and no screen.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import pygame  # noqa: E402

from .body import Snapshot  # noqa: E402
from .render import Observer, View, draw, layout  # noqa: E402

N = 8


def flat(value: float = 0.0) -> list:
    return [[value] * N for _ in range(N)]


def snap(actual=None, color=(255, 255, 255), person=None, pressed=None, t=0.0) -> Snapshot:
    actual = actual if actual is not None else flat()
    return Snapshot(tick=int(t * 50), t=t, rows=N, cols=N, target=actual, actual=actual,
                    gap_max=flat(), color=tuple(color), person=person, pressed=pressed)


def swell(phase: float) -> list:
    """A smooth swell spreading from the centre, as a breathing order might look."""
    out = []
    for r in range(N):
        row = []
        for c in range(N):
            d = math.hypot(r - 3.5, c - 3.5) / 5
            row.append(round(max(0.0, min(1.0, 0.5 + 0.45 * math.sin(phase - d * 2.2))), 3))
        out.append(row)
    return out


def observer(events: list[dict]) -> Observer:
    obs = Observer()
    for ev in events:
        obs.add(ev)
    return obs


HEADER = {"type": "header", "t": 0.0, "mind": "live", "model": "claude-sonnet-5-5"}

STORY = [
    HEADER,
    {"type": "person", "t": 3.1, "tick": 155, "pos": [10.2, 4.1]},
    {"type": "wake", "t": 3.12, "turn": 1, "reasons": ["arrival"], "message": '{"t": 3.12}'},
    {"type": "thought", "t": 6.4, "turn": 1, "kind": "thinking",
     "text": "A time and nothing else. I should find out what I am before I do anything."},
    {"type": "call", "t": 6.5, "turn": 1, "tick": 325, "name": "sense", "args": {},
     "result": {"t": 6.5, "actual": flat(), "gap": flat(), "person": [10.2, 4.1],
                "color": [255, 255, 255]}},
    {"type": "thought", "t": 9.0, "turn": 1, "kind": "text",
     "text": "Sixty-four values, all zero, in eight rows. Something is near, just past the last row. "
             "I will try lifting everything, slowly, and coming back down."},
    {"type": "call", "t": 9.1, "turn": 1, "tick": 455, "name": "play",
     "args": {"tracks": [{"pins": "all", "keyframes": [[0, 0], [2, 0.6], [4, 0]], "loop": True}]},
     "result": {"ok": True, "t": 9.1}},
    {"type": "call", "t": 9.2, "turn": 1, "tick": 460, "name": "set_color",
     "args": {"rgb": [120, 170, 255]}, "result": {"ok": True, "t": 9.2}},
    {"type": "turn_end", "t": 9.3, "turn": 1, "tool_calls": 3, "capped": False, "skipped": False},
    {"type": "voice", "t": 14.0, "tick": 700, "text": "hello?"},
    {"type": "wake", "t": 14.02, "turn": 2, "reasons": ["voice"],
     "message": '{"t": 14.02, "heard": ["hello?"]}'},
    {"type": "call", "t": 17.0, "turn": 2, "tick": 850, "name": "sense", "args": {},
     "result": {"t": 17.0, "actual": swell(1.2), "gap": flat(0.04), "person": [6.3, 9.0],
                "color": [120, 170, 255]}},
    {"type": "thought", "t": 18.2, "turn": 2, "kind": "thinking",
     "text": "It moved closer when I rose. The gap is small and even everywhere: my own lag, not a touch."},
    {"type": "call", "t": 18.4, "turn": 2, "tick": 920, "name": "play",
     "args": {"tracks": [{"pins": [[3, 3], [3, 4], [4, 3], [4, 4]], "keyframes": [[0, 0.2], [0, 0.9]]}]},
     "result": {"ok": False, "t": 18.4, "error": "That movement cannot be understood."}},
    {"type": "call", "t": 18.6, "turn": 2, "tick": 930, "name": "play",
     "args": {"tracks": [{"pins": [[3, 3], [3, 4], [4, 3], [4, 4]],
                          "keyframes": [[0, 0.2], [0.6, 0.9], [1.2, 0.2]], "loop": True},
                         {"pins": [[0, 0], [7, 7]], "keyframes": [[0, 0], [3, 1]], "delay_s": 1}]},
     "result": {"ok": True, "t": 18.6}},
    {"type": "turn_end", "t": 18.7, "turn": 2, "tool_calls": 3, "capped": False, "skipped": False},
]


def scene(name: str, size: tuple) -> tuple[Snapshot | None, View]:
    """(snapshot, view) for a canned scene."""
    lay = layout(size, False)
    near = lay.to_pixels((9.4, 5.2))       # just below the grid, in the margin
    if name == "intro":
        return snap(), View(observer=observer([HEADER]), intro=1.0)
    if name == "dormant":
        return snap(person=(9.4, 5.2), t=4.0), View(observer=observer(STORY[:3]), intro=0.0, cursor=near)
    if name == "breathing":
        s = snap(swell(1.4), color=(120, 170, 255), person=(6.3, 9.4), t=21.0)
        return s, View(observer=observer(STORY[:9]), intro=0.0, cursor=lay.to_pixels((6.3, 9.4)))
    if name == "touch":
        field = flat(0.7)
        field[3][5] = 0.18
        s = snap(field, color=(255, 196, 150), person=(3.5, 5.5), pressed=(3, 5), t=48.0)
        return s, View(observer=observer(STORY[:9]), intro=0.0,
                       cursor=lay.to_pixels((3.5, 5.5)), pressing=True, typing="can you feel th")
    if name == "panel":
        s = snap(swell(2.0), color=(120, 170, 255), person=(6.3, 9.0), t=19.0)
        view = View(observer=observer(STORY), intro=0.0, panel=True)
        view.cursor = layout(size, True).to_pixels((6.3, 9.0))
        return s, view
    if name == "thinking":
        obs = observer(STORY[:3])
        return snap(person=(9.4, 5.2), t=8.4), View(observer=obs, intro=0.0, cursor=near)
    if name == "ended":
        events = STORY + [{"type": "close", "t": 900.0, "reason": "max_turns", "turns": 40,
                           "input_tokens": 412000, "output_tokens": 18300}]
        s = snap(swell(0.4), color=(120, 170, 255), t=900.0)
        return s, View(observer=observer(events), intro=0.0,
                       log_path="sessions/2026-11-12_101500.jsonl")
    if name == "nokey":
        header = dict(HEADER, mind="none")
        return snap(t=2.0), View(mode="nokey", observer=observer([header]), intro=1.0)
    if name == "nokey-arrived":
        header = dict(HEADER, mind="none")
        return snap(person=(9.4, 5.2), t=9.0), View(mode="nokey", observer=observer([header]),
                                                     intro=0.0, cursor=near)
    if name == "dryrun":
        header = dict(HEADER, mind="scripted")
        events = [header] + STORY[1:9]
        s = snap(swell(0.9), color=(120, 170, 255), person=(9.4, 5.2), t=12.0)
        return s, View(mode="dryrun", observer=observer(events), intro=0.0, cursor=near)
    if name == "replay":
        field = swell(2.6)
        field[2][2] = 0.1
        s = snap(field, color=(255, 196, 150), person=(2.5, 2.5), pressed=(2, 2), t=83.0)
        return s, View(mode="replay", observer=observer(STORY), intro=0.0,
                       replay_name="2026-11-12_101500.jsonl", replay_progress=0.31,
                       replay_total=268.0, speed=2.0)
    if name == "error":
        events = STORY[:3] + [
            {"type": "api_error", "t": 8.0, "turn": 1, "attempt": 1, "error": "APIConnectionError: Connection error."},
            {"type": "api_error", "t": 12.0, "turn": 1, "attempt": 2, "error": "APIConnectionError: Connection error."},
            {"type": "api_error", "t": 20.0, "turn": 1, "attempt": 3,
             "error": "APIStatusError 529: overloaded_error: Overloaded"}]
        return snap(person=(9.4, 5.2), t=21.0), View(observer=observer(events), intro=0.0, cursor=near)
    if name == "help":
        return snap(t=4.0), View(observer=observer(STORY[:3]), intro=0.0, help=True, cursor=near)
    if name == "clean":
        s = snap(swell(1.4), color=(120, 170, 255), person=(6.3, 9.4), t=21.0)
        return s, View(observer=observer(STORY), intro=0.0, clean=True, panel=True,
                       cursor=lay.to_pixels((6.3, 9.4)))
    raise KeyError(name)


SCENES = ["intro", "dormant", "thinking", "breathing", "touch", "panel", "ended", "nokey",
          "nokey-arrived", "dryrun", "replay", "error", "help", "clean"]


def render_scene(name: str, size: tuple = (1280, 800)) -> pygame.Surface:
    if not pygame.get_init():
        pygame.init()
    surf = pygame.Surface(size)
    s, view = scene(name, size)
    draw(surf, s, view)
    return surf


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m lab.shot", description=__doc__.splitlines()[0])
    ap.add_argument("scene", help="one of: " + ", ".join(SCENES) + ", or all")
    ap.add_argument("out", help="PNG file, or a directory with `all`")
    ap.add_argument("--size", default="1280x800")
    args = ap.parse_args(argv)
    size = tuple(int(v) for v in args.size.lower().split("x"))
    pygame.init()
    names = SCENES if args.scene == "all" else [args.scene]
    for name in names:
        if name not in SCENES:
            print(f"unknown scene {name!r}; choose from {', '.join(SCENES)}", file=sys.stderr)
            return 2
        out = Path(args.out) / f"{name}.png" if args.scene == "all" else Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        pygame.image.save(render_scene(name, size), str(out))
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
