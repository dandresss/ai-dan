"""Expected outputs of the pure helpers in lab/render.py, for tests/render.test.js.

Run from web/:

    ../.venv/Scripts/python.exe tests/fixtures/render_fixtures.py

It writes tests/fixtures/render.json next to this file. Events go through a
JSON round trip first, because the page only ever sees JSON-normalised events.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

HERE = Path(__file__).resolve().parent
LAB_ROOT = HERE.parents[2]          # ai-dan/
sys.path.insert(0, str(LAB_ROOT))

from lab import render  # noqa: E402
from lab import shot  # noqa: E402
from lab.log import read_log  # noqa: E402


def norm(value):
    return json.loads(json.dumps(value))


class FakeFont:
    """Every character is 7 px wide: enough to pin down the wrapping rules."""

    def size(self, s):
        return (7 * len(s), 10)


def rect(r):
    return None if r is None else [r.x, r.y, r.width, r.height]


def clock_cases():
    return [[t, render.clock(t)] for t in
            [0, 0.4, 9.99, 59.99, 60, 61.5, 754.2, 3599, 3600, -2.5, 900.0]]


def format_cases():
    xs = [2.0, 0.5, 12.0, 1.2, 0.1, 1e-05, 123456.0, 1234567.0, 0.0001, 1.234e-05, 1e16,
          -3.5, 100.0, 0.0025, 1 / 3, 600.0, -0.0, 0.0, 999999.5, 1e-4, 2.5e-07, 15.0, 0.25]
    fixed = [0.0, 0.625, 0.125, 0.375, 2.675, 0.005, 0.015, 0.025, 0.51, 0.49, 1.0, 0.6666666,
             -0.0, -0.125, 0.995, 0.994999, 0.14, 0.67, 1e-17, 0.045]
    return {
        "g": [[x, f"{x:g}"] for x in xs],
        "fixed2": [[x, f"{x:.2f}"] for x in fixed],
    }


def wrap_cases():
    f = FakeFont()
    texts = [
        "",
        "short",
        "An AI wakes up inside this surface of 64 pins. Nobody has told it what it is.",
        "two  spaces   kept when it fits",
        "line one\nline two is a little longer than the width allows\n\nafter a blank",
        "averyveryverylongwordthatcannotfitonasingleline and then more words",
        "trailing newline\n",
        "  leading spaces that do not fit within the narrow width at all",
        "a\r\nwindows\rold mac",
    ]
    out = []
    for s in texts:
        for width in (70, 140, 300):
            out.append({"text": s, "width": width, "lines": render.wrap(f, s, width)})
    return out


def layout_cases():
    sizes = [(1280, 800), (1920, 1080), (800, 600), (1100, 760), (640, 480), (2560, 1440),
             (1024, 768), (700, 900), (601, 1200), (1366, 657)]
    out = []
    for size in sizes:
        for panel in (False, True):
            lay = render.layout(size, panel)
            out.append({"size": list(size), "panel": panel, "room": rect(lay.room),
                        "grid": rect(lay.grid), "pitch": lay.pitch,
                        "panelRect": rect(lay.panel), "u": lay.u})
    return out


def crafted_calls():
    play = lambda args: {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "play",  # noqa: E731
                         "args": args, "result": {"ok": True, "t": 1.0}}
    sense = lambda res: {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "sense",  # noqa: E731
                         "args": {}, "result": res}
    color = lambda rgb: {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "set_color",  # noqa: E731
                         "args": {"rgb": rgb} if rgb is not None else {}, "result": {"ok": True, "t": 1.0}}
    flat = [[0.0] * 8 for _ in range(8)]
    many = [{"pins": [[r, 0]], "keyframes": [[0, 0], [1 + r, 1]], "loop": r % 2 == 0} for r in range(5)]
    return [
        play({"tracks": "x"}),
        play(None),
        play({"tracks": many}),
        play({"tracks": [{"pins": [[1, 1]], "keyframes": [[0, 0], [0.5, 1]]}]}),
        play({"tracks": [{"pins": "all", "keyframes": [[0]]}]}),
        play({"tracks": [{"pins": [[1, 2], [3, 4]], "keyframes": [[0, 0], [2.5, 1]], "delay_s": True}]}),
        play({"tracks": [{"pins": 3, "keyframes": [[0, 0], [2, 1]], "delay_s": "2"}]}),
        play({"tracks": [{"pins": "all", "keyframes": [[0, 0], [2, 1]], "delay_s": 0, "loop": []}]}),
        play({"tracks": [{"pins": "all", "keyframes": [["1", "0.5"], ["3", "1"]], "loop": "yes"}]}),
        play({"tracks": [{"pins": "all", "keyframes": [[0, 0], [0, 1]]}, 7, "junk"]}),
        play({"tracks": [{"pins": "all", "keyframes": [[0, 0], [1.25, 1]], "delay_s": 0.75}]}),
        sense({"t": 2.0, "actual": flat, "gap": flat, "person": None, "color": [255, 255, 255]}),
        sense({"t": 2.0, "actual": [[0.125, 0.625], [0.995, 0.3]], "person": [6.3, 9.0]}),
        sense({"t": 2.0, "actual": [[0.1, "x"]], "gap": flat, "person": [1.5, 2.5]}),
        sense({"ok": False, "t": 2.0, "error": "That cannot be sensed."}),
        color([300, -5, 12.7]),
        color("red"),
        color(None),
        color([1, 2]),
        color([10, 20, 30, 40]),
        {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "stop", "args": {}, "result": {"ok": True, "t": 1.0}},
        {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "stop", "args": {"pins": [[1, 1], [2, 2]]},
         "result": {"ok": True, "t": 1.0}},
        {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "stop", "args": {"pins": "x"},
         "result": {"ok": True, "t": 1.0}},
        {"type": "call", "t": 1.0, "turn": 1, "name": "remember", "args": {"text": "the warm thing comes back"},
         "result": {"ok": True, "t": 1.0}},
        {"type": "call", "t": 1.0, "turn": 1, "name": "remember", "args": {"x": 1},
         "result": {"ok": False, "t": 1.0, "error": "That note cannot be understood."}},
        {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "name": "dance", "args": {"a": "é", "b": [1, 2]},
         "result": {"ok": False, "t": 1.0, "error": "There is no such thing."}},
        {"type": "call", "t": 1.0, "turn": 1, "tick": 50, "args": {"long": "x" * 120},
         "result": {"ok": False, "t": 1.0, "error": "?"}},
    ]


def call_cases():
    events = []
    for path in sorted((LAB_ROOT / "sessions").glob("*.jsonl")) + [LAB_ROOT / "docs" / "first-wake.jsonl"]:
        events += [e for e in read_log(path) if e.get("type") == "call"]
    events += [e for e in shot.STORY if e.get("type") == "call"]
    events += crafted_calls()
    out = []
    for ev in events:
        ev = norm(ev)
        line, curves, swatch = render._call_line(ev)
        out.append({"ev": ev, "line": line, "curves": norm(curves), "swatch": norm(swatch)})
    return out


def status_cases():
    H = shot.HEADER
    cfg_header = dict(H, config={"PULSE_S": 8.0})
    S = shot.STORY
    err = S[:3] + [{"type": "api_error", "t": 8.0, "turn": 1, "attempt": 1, "error": "x"}]
    scenarios = [
        ("no header", [], 0.0, "live"),
        ("waiting", [H], 0.0, "live"),
        ("none", [dict(H, mind="none")], 3.0, "live"),
        ("nokey mode", [H], 3.0, "nokey"),
        ("awake, just woke", S[:3], 3.5, "live"),
        ("awake, first thought slow", S[:3], 8.4, "live"),
        ("awake, later turn slow", S[:11], 60.0, "live"),
        ("awake, later turn a little slow", S[:11], 20.0, "live"),
        ("awake, one call", S[:5], 6.6, "live"),
        ("awake, calls", S[:8], 9.2, "live"),
        ("asleep, no config", S[:9], 10.0, "live"),
        ("asleep, pulse from config", [cfg_header] + S[1:9], 10.0, "live"),
        ("awake, error", err, 9.0, "live"),
        ("ended", S + [{"type": "close", "t": 30.0, "reason": "max_turns", "turns": 2,
                        "input_tokens": 10, "output_tokens": 2}], 30.0, "live"),
        ("replay, asleep", S, 30.0, "replay"),
    ]
    out = []
    for name, events, t, mode in scenarios:
        events = norm(events)
        obs = render.Observer()
        for ev in events:
            obs.add(ev)
        word, color, detail = render.mind_status(obs, t, render.View(mode=mode, observer=obs))
        out.append({"name": name, "events": events, "t": t, "mode": mode,
                    "status": [word, list(color), detail]})
    return out


def observer_case():
    events = norm(read_log(LAB_ROOT / "docs" / "first-wake.jsonl"))
    obs = render.Observer()
    for ev in events:
        obs.add(ev)
    return {
        "status": obs.status, "turn": obs.turn, "wake_t": obs.wake_t,
        "calls_this_turn": obs.calls_this_turn, "errors_in_a_row": obs.errors_in_a_row,
        "arrived": obs.arrived, "mind": obs.mind,
        "entries": [ev["type"] for _, ev in obs.entries],
    }


def main():
    data = {
        "clock": clock_cases(),
        "format": format_cases(),
        "wrap": wrap_cases(),
        "layout": layout_cases(),
        "calls": call_cases(),
        "status": status_cases(),
        "observer": observer_case(),
    }
    out = HERE / "render.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
