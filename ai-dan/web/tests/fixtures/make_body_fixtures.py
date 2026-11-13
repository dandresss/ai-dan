"""Record the Python lab's answers for the JavaScript body to reproduce.

    cd web && ../.venv/Scripts/python.exe tests/fixtures/make_body_fixtures.py

Writes body.json next to this file:

  rounds      [repr(x), round(x), [round(x, n) for n in n_all], [... n_some]]
              (repr reads back exactly, so it carries the float)
  repr        [x as hex bits, repr(x)] for random doubles of every size
  dumps       json.dumps(v, ensure_ascii=False) of values that follow the
              key-based typing rule of web/ARCHITECTURE.md
  cos         cos(pi * u) and (1 - cos(pi * u)) / 2 for u = k / (n - 1), each
              as one hex string (16 digits a value), to compare the C
              library's cos with Math.cos
  bodies      scripted SimBody runs: every call's result and state_hash()
  world       a scripted World session: the exact log text and the events
  replays     crafted logs run through ReplayWorld, tick by tick

Floats travel as repr strings or hex bits, never lossy. Call arguments travel as
JSON, with NaN and infinities tagged as {"__py__": "nan" | "inf" | "-inf"}.
Nothing here is random at run time: the "random" values come from a seeded
generator, so the file is the same every time it is made.
"""
from __future__ import annotations

import copy
import dataclasses
import json
import math
import random
import struct
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))   # the folder that holds the `lab` package

from lab.config import Config               # noqa: E402
from lab.log import SessionLog              # noqa: E402
from lab.simbody import SimBody             # noqa: E402
from lab.world import ReplayWorld, World    # noqa: E402
from lab.body import WorldClosed            # noqa: E402

COS_N = 6001
rng = random.Random(20261112)


def hexf(x: float) -> str:
    return struct.pack(">d", x).hex()


def unhex(h: str) -> float:
    return struct.unpack(">d", bytes.fromhex(h))[0]


def random_double() -> float:
    """Any finite double, from its bits."""
    while True:
        x = unhex(f"{rng.getrandbits(64):016x}")
        if math.isfinite(x):
            return x


def enc(x):
    """JSON-safe copy of a call argument."""
    if isinstance(x, float) and not math.isfinite(x):
        return {"__py__": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    if isinstance(x, dict):
        return {k: enc(v) for k, v in x.items()}
    return x


# --- numbers -----------------------------------------------------------------
def number_cases() -> list[float]:
    xs = [0.0, -0.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, 0.49999999999999994, 5e-324,
          -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
          2.0 ** 52 - 0.5, 2.0 ** 52 + 1, 2.0 ** 53, 2.0 ** 53 + 2, 1e16, 1e15, 1e-4, 1e-5,
          0.1, 0.2, 0.1 + 0.2, 2.675, 1.005, 0.285, 2.25, 0.125, 0.375, 1e21, 1e22, 1e-7,
          123456789.123456789, 4.35, 9.995, 0.045, 1 / 3, 2 / 3, math.pi, math.e]
    xs += [k + 0.5 for k in range(-60, 61)]                  # round() ties
    xs += [k / 8 for k in range(-80, 81)]                    # ties at 2 decimals
    xs += [k / 4 for k in range(-40, 41)]                    # ties at 1 decimal
    xs += [k / 1024 for k in range(-300, 301, 7)]            # ties at 9 decimals
    xs += [(2 * k + 1) / 2 ** 14 for k in range(0, 400, 13)]
    xs += [k / 50 for k in range(0, 2000, 7)]                # tick times
    xs += [k / 63 for k in range(64)]                        # quantized heights
    xs += [k / 63 * 63 for k in range(64)]
    xs += [rng.uniform(-10, 10) for _ in range(150)]
    xs += [rng.uniform(0, 1) for _ in range(150)]
    xs += [rng.uniform(-1, 1) * 10 ** rng.randint(-12, 22) for _ in range(150)]
    xs += [round(rng.uniform(-20, 20), rng.randint(1, 4)) + 0.005 for _ in range(150)]
    xs += [random_double() for _ in range(150)]
    return xs


N_ALL = (0, 1, 2, 3, 9)
N_SOME = (-2, -1, 4, 5, 6, 7, 8, 12, 17, 20, 30, 330, -400)


def round_cases(xs):
    """[x, round(x), [round(x, n) for n in N_ALL], [round(x, n) for n in N_SOME] or []]."""
    out = []
    for i, x in enumerate(xs):
        some = [repr(round(x, n)) for n in N_SOME] if i % 5 == 0 else []
        out.append([repr(x), str(round(x)), [repr(round(x, n)) for n in N_ALL], some])
    return out


def repr_cases():
    extra = [random_double() for _ in range(1500)]
    extra += [rng.uniform(-1, 1) * 10.0 ** e for e in range(-30, 31) for _ in range(5)]
    extra += [10.0 ** e for e in range(-20, 25)] + [-(10.0 ** e) for e in range(-20, 25)]
    extra += [float(2 ** e) for e in range(0, 80, 3)]
    return [[hexf(x), repr(x)] for x in extra]


def dumps_cases():
    values = [
        None, True, False, 0, -7, 2 ** 70, -(2 ** 63), 10 ** 20, 10 ** 21, 10 ** 22, 0.5, -2.5e-10,
        1e-05, 123.456, [], {}, [[]], [{}], {"a": []}, "", "plain",
        "quote \" backslash \\ slash / newline \n tab \t cr \r bell \x07 nul \x00 unit \x1f del \x7f",
        "é ü 中文 😀 \u2028 \u2029 \ufeff \u00a0", {"t": 0.0}, {"t": 12.0}, {"t": 0.02},
        {"t": 1e16}, {"t": 1e22}, {"t": -0.0}, {"t": 5e-324}, {"t": 1e-05}, {"t": 0.0001},
        {"x": -0.0}, {"pos": [4.0, 9.0]}, {"pos": None}, {"person": [2.2, -0.8]},
        {"pos": [1e300, -1.5e-300]}, {"ok": True, "t": 0.02},
        {"ok": False, "t": 1.5, "error": "That movement cannot be understood."},
        {"type": "press", "tick": 120, "t": 2.4, "pin": [3, 3]},
        {"type": "turn_end", "t": 3.0, "turn": 1, "tool_calls": 2, "capped": False, "skipped": False},
        {"nested": {"deeper": {"t": [1.0, [2.0, {"z": 3.0}]]}, "n": 3}, "t": {"inner": 4.0}},
        {"actual": [[0.0, 0.25], [1.0, 0.5]], "gap": [[0.0, 0.0]], "color": [255, 0, 12]},
        {"FULL_TRAVEL_S": 0.5, "MAX_TRACK_S": 600.0, "PULSE_S": 12.0, "ABSENCE_GRACE_S": 2.0,
         "MAX_SESSION_MIN": 15.0, "MAX_TOKENS": 4096, "DEFAULT_COLOR": [255, 255, 255]},
        {"config": Config().to_dict(), "version": 1},
        {"keys in order": 1, "b": 2, "a": 3, "é": 4, "": 5},
    ]
    sense = SimBody(Config()).call("sense")
    values.append({"type": "call", "turn": 1, "tick": 0, "t": 0.0, "name": "sense", "args": {},
                   "result": sense})
    values += [{"t": rng.uniform(0, 1000)} for _ in range(50)]
    values += [{"pos": [round(rng.uniform(-2, 10), 2), round(rng.uniform(-2, 10), 2)]} for _ in range(50)]
    values += [{"v": rng.uniform(-1, 1) * 10.0 ** rng.randint(-20, 10)} for _ in range(50)]
    return [json.dumps(v, ensure_ascii=False) for v in values]


def cos_results():
    raw, smooth = [], []
    for k in range(COS_N):
        u = k / (COS_N - 1)
        raw.append(hexf(math.cos(math.pi * u)))
        smooth.append(hexf((1 - math.cos(math.pi * u)) / 2))
    return {"n": COS_N, "cos": "".join(raw), "smooth": "".join(smooth)}


# --- the body ------------------------------------------------------------------
NO_TRACK = {"pins": [[0, 0]], "keyframes": [[0, 0.2], [1, 0.8]]}
KF = [[0, 0.2], [1, 0.8]]

BAD_TRACKS = [
    {"pins": [[8, 0]], "keyframes": KF}, {"pins": [[0, 8]], "keyframes": KF},
    {"pins": [[-1, 0]], "keyframes": KF}, {"pins": "all", "keyframes": [[0, 0]] * 17},
    {"pins": "all", "keyframes": [[0, 0], [601, 1]]}, {"pins": "all", "keyframes": KF, "delay_s": 601},
    {"pins": "all", "keyframes": [[0, 0]]}, {"pins": "all", "keyframes": []},
    {"pins": "all", "keyframes": [[1, 0], [2, 1]]}, {"pins": "all", "keyframes": [[0, 0], [1, 1], [1, 0]]},
    {"pins": "all", "keyframes": [[0, 0], [2, 1], [1, 0]]}, {"keyframes": KF},
    {"pins": "some", "keyframes": KF}, {"pins": [], "keyframes": KF}, {"pins": [[0]], "keyframes": KF},
    {"pins": [[0, 0.5]], "keyframes": KF}, {"pins": [[True, 0]], "keyframes": KF},
    {"pins": [["0", 0]], "keyframes": KF}, {"pins": "all"}, {"pins": "all", "keyframes": "up"},
    {"pins": "all", "keyframes": [[0, "a"], [1, 1]]},
    {"pins": "all", "keyframes": [[0, 0], [1, float("nan")]]},
    {"pins": "all", "keyframes": [[0, 0], [float("inf"), 1]]},
    {"pins": "all", "keyframes": [[0, 0], [1, True]]}, {"pins": "all", "keyframes": [[0, 0], [1]]},
    {"pins": "all", "keyframes": KF, "delay_s": -1}, {"pins": "all", "keyframes": KF, "delay_s": "soon"},
    {"pins": "all", "keyframes": KF, "ease": "bouncy"}, {"pins": "all", "keyframes": KF, "loop": "yes"},
    {"pins": "all", "keyframes": KF, "loop": 1}, "not an object",
    # where several problems meet, the first check in Python's order wins
    {"pins": [[9, 9], [0]], "keyframes": KF}, {"pins": [[9, 9]], "keyframes": [[1, 0]]},
    {"pins": [[0, 0]], "keyframes": [[1, 0], [700, 1]]}, {"pins": [[0, 0]], "keyframes": [[0, 0]] * 20 + ["x"]},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "loop": "yes", "delay_s": 700},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "delay_s": 700, "ease": "smooth"},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "ease": ["smooth"]},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "delay_s": float("inf")},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "delay_s": 10 ** 400},
    {"pins": [[2 ** 70, 0]], "keyframes": KF}, {"pins": [[1e300, 0]], "keyframes": KF},
    {"pins": [[0, -0.0]], "keyframes": [[-1, 0], [1, 1]]}, {"pins": [[None, 0]], "keyframes": KF},
    {"pins": [[[0], 0]], "keyframes": KF}, {"pins": [[0, 0, 0]], "keyframes": KF},
    {"pins": {"0": 0}, "keyframes": KF}, {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "loop": 0},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]], "delay_s": True},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [0.5, 1], [0.5, 0]]},
    {"pins": [[0, 0]], "keyframes": [[0, 0], [-1, 1]]},
    {"pins": [[0, 0]], "keyframes": [[0.0001, 0], [1, 1]]},
]

BAD_PLAY_ARGS = [None, {}, {"tracks": None}, {"tracks": []}, {"tracks": "x"}, "play", [], 5, True,
                 {"tracks": {"pins": "all"}}, {"tracks": [{"pins": "all", "keyframes": KF}] * 17},
                 {"tracks": [{"pins": "all", "keyframes": KF}] * 17 + ["bad"]},
                 {"Tracks": [{"pins": "all", "keyframes": KF}]}]

BAD_COLORS = [None, "red", [1, 2], [1, 2, 3, 4], [-1, 0, 0], [0, 0, 256], [1.5, 0, 0], [True, 0, 0],
              ["1", 2, 3], [math.nan, 0, 0], [math.inf, 0, 0], {"r": 1}, [None, 0, 0], [[1], 2, 3],
              [255.5, 0, 0], [-0.5, 0, 0], [10 ** 400, 0, 0], []]

GARBAGE = [None, 1, 1.5, "x", [], {}, [None], {"tracks": [None]}, {"tracks": [[]]}, {"tracks": [{}]},
           {"tracks": [{"pins": {}, "keyframes": {}}]}, {"rgb": {}}, {"pins": 10 ** 400},
           {"tracks": [{"pins": "all", "keyframes": [[10 ** 400, 0], [1, 1]]}]},
           {"tracks": [{"pins": [[10 ** 400, 0]], "keyframes": KF}]}]


def snapshot_dict(snap) -> dict:
    d = dataclasses.asdict(snap)
    for key in ("color", "person", "pressed"):
        d[key] = list(d[key]) if d[key] is not None else None
    return d


class Recorder:
    def __init__(self, overrides: dict):
        self.overrides = overrides
        self.body = SimBody(Config(**overrides))
        self.ops: list[dict] = []

    def call(self, name, args=None):
        result = self.body.call(name, copy.deepcopy(args))
        self.ops.append({"op": "call", "name": name, "args": enc(args),
                         "result": json.dumps(result, ensure_ascii=False), "hash": self.body.state_hash()})

    def step(self, n=1, snap=False):
        for _ in range(n):
            self.body.step()
        op = {"op": "step", "n": n, "hash": self.body.state_hash()}
        if snap:
            op["snapshot"] = snapshot_dict(self.body.snapshot())
        self.ops.append(op)

    def person(self, pos):
        self.body.set_person(pos)
        self.ops.append({"op": "person", "pos": list(pos) if pos is not None else None,
                         "hash": self.body.state_hash()})

    def pressed(self, pin):
        self.body.set_pressed(pin)
        self.ops.append({"op": "pressed", "pin": list(pin) if pin is not None else None,
                         "hash": self.body.state_hash()})

    def out(self, name):
        return {"name": name, "config": self.overrides, "ops": self.ops}


def quantization_ties(levels=64):
    """Heights h with h * (levels - 1) exactly halfway between two levels."""
    top = levels - 1
    found = []
    for k in range(top):
        h = (k + 0.5) / top
        for candidate in (h, math.nextafter(h, 0), math.nextafter(h, 1)):
            if candidate * top == k + 0.5:
                found.append(candidate)
                break
    return found


def default_body():
    r = Recorder({})
    r.call("sense")
    r.call("sense", {})
    for track in BAD_TRACKS:
        r.call("play", {"tracks": [NO_TRACK, track]})
    for args in BAD_PLAY_ARGS:
        r.call("play", args)
    for rgb in BAD_COLORS:
        r.call("set_color", {"rgb": rgb})
    for args in (None, "rgb", [1, 2, 3], {"color": [1, 2, 3]}):
        r.call("set_color", args)
    for args in ({"pins": [[8, 8]]}, {"pins": []}, {"pins": "most"}, "all", [[0, 0]], 7,
                 {"pins": [[0, 0], [0]]}, {"pins": [[0, 9], [0]]}):
        r.call("stop", args)
    for name in ("fly", None, 5, "Play", "sense ", ""):
        r.call(name, {})
    for name in ("play", "stop", "sense", "set_color", "other", None, 5):
        for args in GARBAGE:
            r.call(name, args)

    # A breath, with the person moving around and pausing on rounding ties.
    r.call("play", {"tracks": [{"pins": "all", "keyframes": [[0, 0.1], [1, 0.9], [2, 0.1]], "loop": True}]})
    r.step(30, snap=True)
    r.call("sense")
    for pos in ((2.25, 3.75), (0.25, -0.75), (2.35, 4.45), (-0.05, 7.95), (9.5, -1.0), (3.24, 9.16),
                (0.15, 0.85), (-0.25, -0.35), (1e-12, -1e-12), (4.0, 9.0)):
        r.person(pos)
        r.call("sense")
    r.step(20)
    r.pressed((2, 3))
    r.step(5, snap=True)
    r.call("sense")
    r.pressed(None)
    r.step(40)
    r.call("sense")
    r.call("sense")

    # Delays, ease, a pin named in several tracks, a track that finishes.
    r.call("play", {"tracks": [{"pins": [[1, 1], [2, 2]], "keyframes": [[0, 1], [3, 0]], "delay_s": 1.5,
                                "ease": "linear"}]})
    r.step(10)
    r.call("play", {"tracks": [{"pins": "all", "keyframes": [[0, 0.3], [0.7, 0.9], [1.9, 0.2]]},
                               {"pins": [[0, 0], [7, 7]], "keyframes": [[0, 1], [1, 0]], "delay_s": 2},
                               {"pins": [[0, 0]], "keyframes": [[0, 0.5], [0.25, 0.6]], "loop": True}]})
    r.step(25, snap=True)
    r.call("play", {"tracks": [{"pins": [[3, 3]], "keyframes": [[0, 0], [0.5, 0.7]]}]})
    r.step(40, snap=True)
    r.call("play", {"tracks": [{"pins": [[1, 1], [1, 1], [1, 2]], "keyframes": [[0, 0.4], [0.3, 0.8]],
                                "loop": False, "ease": None, "delay_s": None}]})
    r.step(3)
    r.call("stop", {"pins": [[0, 0], [7, 7], [0, 0]]})
    r.step(7)
    r.call("stop", {})
    r.call("stop", None)
    r.call("stop", {"pins": "all"})
    r.call("stop", {"pins": None})
    r.step(5, snap=True)

    # Colour, clipping, signed zeros, limits, extra fields.
    r.call("set_color", {"rgb": [255.0, 0, 12]})
    r.call("set_color", {"rgb": [-0.0, 0, 0]})
    r.call("sense")
    r.call("set_color", {"rgb": [80, 160, 255]})
    r.call("play", {"tracks": [{"pins": "all", "keyframes": [[0, -5], [1, 9]], "ease": "linear"}]})
    r.step(60, snap=True)
    r.call("play", {"tracks": [{"pins": [[4, 4]], "keyframes": [[-0.0, -0.0], [1, -0.0]], "delay_s": -0.0}]})
    r.step(2)
    r.call("play", {"tracks": [{"pins": "all", "keyframes": KF}] * 16})
    r.call("play", {"tracks": [{"pins": "all", "keyframes": [[i, 0.5] for i in range(16)], "delay_s": 600}]})
    r.call("play", {"tracks": [{"pins": [[5, 5]], "keyframes": [[0, 0], [600, 1]]}]})
    r.call("play", {"tracks": [{"pins": [[2.0, 3.0]], "keyframes": KF, "extra": "x"}], "more": 1})
    r.call("sense", {"anything": 1})
    r.step(10)

    # Heights that sit exactly between two levels: Python rounds them to even.
    ties = quantization_ties()
    tracks = [{"pins": [[k // 8, k % 8]], "keyframes": [[0, h], [1, h]]} for k, h in enumerate(ties)]
    for i in range(0, len(tracks), 16):
        r.call("play", {"tracks": tracks[i:i + 16]})
    r.step(6, snap=True)

    # A long stretch of motion with a touch in the middle.
    r.call("play", {"tracks": [
        {"pins": [[r_, c] for r_ in range(8) for c in range(8) if (r_ + c) % 2 == 0],
         "keyframes": [[0, 0.05], [0.37, 0.93], [1.13, 0.4], [2.71, 0.66]], "loop": True},
        {"pins": [[r_, c] for r_ in range(8) for c in range(8) if (r_ + c) % 2 == 1],
         "keyframes": [[0, 0.8], [1.7, 0.1], [3.3, 0.8]], "loop": True, "ease": "linear", "delay_s": 0.33}]})
    for k in range(6):
        if k == 2:
            r.pressed((7, 7))
        if k == 3:
            r.pressed((0, 1))
        if k == 4:
            r.pressed(None)
        r.step(50, snap=True)
        r.call("sense")
    r.call("stop", {"pins": [[3, 4]]})
    r.step(500, snap=True)
    return r.out("default")


def small_body():
    """A small grid with an odd clock: tick times fall on ties of round(x, 2)."""
    r = Recorder({"GRID_ROWS": 3, "GRID_COLS": 5, "TICK_HZ": 8, "LEVELS": 16, "RESPONSE_MS": 312.5,
                  "FULL_TRAVEL_S": 0.75, "MAX_TRACKS": 3, "MAX_KEYFRAMES": 4, "MAX_TRACK_S": 10.0,
                  "DEFAULT_COLOR": [10, 20, 30]})
    for _ in range(9):
        r.call("sense")
        r.step()
    for args in ({"tracks": [{"pins": [[3, 0]], "keyframes": KF}]},
                 {"tracks": [{"pins": [[0, 5]], "keyframes": KF}]},
                 {"tracks": [{"pins": "all", "keyframes": KF}] * 4},
                 {"tracks": [{"pins": "all", "keyframes": [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]]}]},
                 {"tracks": [{"pins": "all", "keyframes": [[0, 0], [11, 1]]}]},
                 {"tracks": [{"pins": "all", "keyframes": KF, "delay_s": 10.5}]}):
        r.call("play", args)
    r.call("play", {"tracks": [{"pins": [[2, 4], [0, 0]], "keyframes": [[0, 0.1], [1, 0.9], [2, 0.1]],
                                "loop": True},
                               {"pins": [[1, 2]], "keyframes": [[0, 1], [0.375, 0.5]], "ease": "linear"}]})
    r.person((1.25, 4.75))
    for k in range(12):
        r.step(3, snap=k % 3 == 0)
        r.call("sense")
        if k == 5:
            r.pressed((2, 4))
        if k == 8:
            r.pressed(None)
    ties = quantization_ties(16)
    r.call("play", {"tracks": [{"pins": [[i // 5, i % 5]], "keyframes": [[0, h], [1, h]]}
                               for i, h in enumerate(ties[:3])]})
    r.step(10, snap=True)
    return r.out("small")


# --- the world ----------------------------------------------------------------
BREATH = {"tracks": [{"pins": "all", "keyframes": [[0, 0.2], [2, 0.8], [4, 0.2]], "loop": True}]}


def world_script():
    """What happens at each loop index: (person, pressed, voices, calls, turn)."""
    script = []
    for i in range(320):
        if i < 5:
            person = None
        elif i < 60:
            person = (4, 9)
        elif i < 120:
            person = [(2.125, 3.375), (2.255, 0.005), (-0.125, 8.875), (2.1251, 3.375)][(i // 7) % 4]
        elif i < 150:
            person = None
        else:
            person = (4.0 + (i % 50) / 50, 9.0 - (i % 30) / 30)
        pressed = None
        if 70 <= i < 80:
            pressed = (3.7, 2.2)
        elif 80 <= i < 85:
            pressed = (8, 0)
        elif 85 <= i < 95:
            pressed = (-0.5, 1)
        elif 200 <= i < 260:
            pressed = [3, 3]
        voices = {2: ["  early  "], 40: ["\x1c hi \x85"], 41: ["\ufeffhey", "   "], 90: ["a\nb  "],
                  300: ["bye"]}.get(i, [])
        calls = {
            2: [("sense", {})],
            10: [("play", BREATH), ("set_color", {"rgb": [255, 120, 40]})],
            33: [("play", {"tracks": "nonsense"})],
            75: [("sense", {}), ("stop", {"pins": [[0, 0], [7, 7]]}), ("sense", None)],
            130: [("fly", {"x": 1.5})],
            205: [("sense", {})],
            249: [("play", {"tracks": [{"pins": [[3, 3], [4, 4]], "keyframes": [[0, 1], [0.5, 0]],
                                        "delay_s": 0.25, "ease": "linear"}]})],
            250: [("sense", {})],
        }.get(i, [])
        turn = {10: 1, 75: 2, 205: 3}.get(i)
        script.append({"person": person, "pressed": pressed, "voices": voices,
                       "calls": [[name, args] for name, args in calls], "turn": turn})
    return script


def world_run():
    script = world_script()
    config = Config(STATE_EVERY_TICKS=40)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.jsonl"
        log = SessionLog(path)
        world = World(config, log)
        futures = []
        for item in script:
            if item["turn"] is not None:
                world.turn = item["turn"]
            for text in item["voices"]:
                world.say(text)
            for name, args in item["calls"]:
                futures.append(world._submit(name, copy.deepcopy(args)))
            world.tick(item["person"], item["pressed"])
        waiting = world._submit("sense", {})      # never ticked: released by close()
        world.close()
        world.close()
        try:
            world._submit("sense", {})
            after_close = "accepted"
        except WorldClosed:
            after_close = "WorldClosed"
        log.close()
        text = path.read_text(encoding="utf-8")
    events = []
    while not world.events.empty():
        events.append(list(world.events.get()))
    return {
        "config": {"STATE_EVERY_TICKS": 40},
        "script": script,
        "log": text,
        "events": events,
        "results": [json.dumps(f.result(), ensure_ascii=False) for f in futures],
        "waiting": type(waiting.exception()).__name__,
        "after_close": after_close,
        "tick": world.body.tick,
        "hash": world.body.state_hash(),
    }


# --- replays -------------------------------------------------------------------
REPLAY_HEADER = {"type": "header", "version": 1, "started_at": "2026-11-12T12:00:00",
                 "config": Config(STATE_EVERY_TICKS=40).to_dict(), "t": 0.0, "mind": "none"}
# Story events whose ticks come from tick_of(t), some of them on ties.
REPLAY_STORY = [
    {"type": "wake", "t": 0.01, "turn": 1, "reasons": ["arrival"], "message": "{\"t\": 0.01}"},
    {"type": "thought", "t": 0.03, "turn": 1, "kind": "text", "text": "tie at 1.5 ticks"},
    {"type": "turn_end", "t": 0.05, "turn": 1, "tool_calls": 0, "capped": False, "skipped": False},
    {"type": "thought", "turn": 1, "kind": "text", "text": "no time at all"},
    {"type": "close", "t": 6.51, "reason": "window_closed", "turns": 1, "input_tokens": 0,
     "output_tokens": 0},
]


def replay_events(world_log: str, name: str) -> list[dict]:
    """The crafted logs; the JavaScript test builds the same ones."""
    events = [json.loads(line) for line in world_log.splitlines()]
    if name == "tampered":
        for ev in events:
            if ev["type"] == "call" and ev["name"] == "play" and ev["result"].get("ok"):
                ev["args"]["tracks"][0]["keyframes"][1][1] = 0.4
                break
    if name == "wrong_result":
        for ev in events:
            if ev["type"] == "call" and ev["name"] == "sense":
                ev["result"]["t"] = 99.0
                break
    header, story = copy.deepcopy(REPLAY_HEADER), copy.deepcopy(REPLAY_STORY)
    return {"world": [header] + events, "story": [header] + events + story,
            "tampered": [header] + events, "wrong_result": [header] + events,
            "header_only": [header], "story_only": [header] + story}[name]


def replay_cases(world_log: str):
    out = []
    for name in ("world", "story", "tampered", "wrong_result", "header_only", "story_only"):
        world = ReplayWorld(replay_events(world_log, name))
        trace = []
        while not world.done:
            world.tick()
            trace.append(len(world.feed))
        out.append({"name": name, "end_tick": world.end_tick, "feed_lengths": trace,
                    "calls": world.calls_replayed, "states": world.states_checked,
                    "mismatches": world.mismatches, "tick": world.body.tick,
                    "hash": world.body.state_hash()})
    return {"header": REPLAY_HEADER, "story": REPLAY_STORY, "cases": out}


def main():
    xs = number_cases()
    world = world_run()
    data = {
        "n_all": N_ALL,
        "n_some": N_SOME,
        "rounds": round_cases(xs),
        "repr": repr_cases(),
        "dumps": dumps_cases(),
        "cos": cos_results(),
        "bodies": [default_body(), small_body()],
        "world": world,
        "replays": replay_cases(world["log"]),
        "quantization_ties": [hexf(h) for h in quantization_ties()],
    }
    text = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    (HERE / "body.json").write_text(text, encoding="utf-8")
    print(f"body.json: {len(text) / 1e6:.2f} MB, {len(data['bodies'][0]['ops'])} + "
          f"{len(data['bodies'][1]['ops'])} body ops, {len(xs)} numbers")


if __name__ == "__main__":
    main()
