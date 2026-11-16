"""Expected outputs of lab/camera.py, for tests/camera.test.js.

Run from web/:

    ../.venv/Scripts/python.exe tests/fixtures/make_camera_fixtures.py

It writes tests/fixtures/camera.json next to this file. Each case builds a
camera the way the desktop's layout does for that window (`args`), then
records what it answers. Points to pick are chosen at the middle of faces and
cells, never on an edge, so the last bit of a cosine cannot change an answer.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

HERE = Path(__file__).resolve().parent
LAB_ROOT = HERE.parents[2]          # ai-dan/
sys.path.insert(0, str(LAB_ROOT))

from lab import camera, render  # noqa: E402


def args_for(size, panel, rows, cols):
    """The camera's arguments for a window, as the desktop's 3D layout makes them,
    checked against the camera that layout really builds."""
    lay = render.layout(size, panel, rows, cols, view3d=True)
    g = lay.grid
    args = [rows, cols, [g.centerx, g.centery], g.height + int(lay.pitch * 0.7), lay.room.width - lay.pitch]
    built = camera.Camera(args[0], args[1], tuple(args[2]), args[3], args[4])
    assert (built.k, built.ox, built.oy) == (lay.camera.k, lay.camera.ox, lay.camera.oy), "render.layout changed"
    return args


def middle(quad):
    return [sum(x for x, _ in quad) / 4, sum(y for _, y in quad) / 4]


def patterns(rows, cols):
    flat = [[0.0] * cols for _ in range(rows)]
    one = [[0.0] * cols for _ in range(rows)]
    one[rows - 2][min(2, cols - 1)] = 1.0
    wave = [[round(0.5 + 0.5 * math.sin(c * 0.9 + r * 0.35), 3) for c in range(cols)] for r in range(rows)]
    ramp = [[round(r / max(1, rows - 1), 3) for _ in range(cols)] for r in range(rows)]
    return {"flat": flat, "one": one, "wave": wave, "ramp": ramp}


def case(size, panel, rows=8, cols=8):
    a = args_for(size, panel, rows, cols)
    cam = camera.Camera(a[0], a[1], tuple(a[2]), a[3], a[4])
    w, h = size
    out = {
        "size": list(size), "panel": panel, "args": a,
        "camera": {"k": cam.k, "ox": cam.ox, "oy": cam.oy, "x": cam.x, "y": cam.y, "z": cam.z,
                   "bounds": list(cam.bounds())},
        "order": [list(p) for p in cam.order()],
        "plate": [[list(p) for p in quad] for quad in cam.plate()],
    }
    worlds = [(0, 0, 0), (cols, rows, 0), (cols / 2, rows / 2, 1.8), (-2.5, rows + 2.0, 0), (3.25, 1.5, 0.9)]
    out["project"] = [[list(p), list(cam.project(*p))] for p in worlds]
    pixels = [(0, 0), (w, 0), (0, h), (w, h), (w / 2, h / 2), (w * 0.31, h * 0.77), (w / 2, -50000.0)]
    out["floor"] = [[list(p), list(cam.floor(p))] for p in pixels]
    faces = []
    for r, c in [(0, 0), (rows // 2 - 1, cols // 2 - 1), (rows // 2 - 1, cols // 2), (rows - 1, cols - 1), (rows - 3, 1)]:
        for hh in (0.0, 0.37, 1.0, 1.4):
            faces.append({"pin": [r, c], "h": hh,
                          "faces": [[kind, [list(p) for p in quad]] for kind, quad in cam.faces(r, c, hh)]})
    out["faces"] = faces

    picks = []
    for name, heights in patterns(rows, cols).items():
        points = []
        for r, c in [(0, 0), (rows - 2, min(2, cols - 1)), (rows // 2, cols // 2), (rows - 1, cols - 1), (1, cols - 2)]:
            for kind, quad in cam.faces(r, c, camera.height(heights, r, c)):
                points.append(middle(quad))
        for row, col in [(rows / 2 + 0.03, cols / 2 + 0.47), (-1.3, 2.2), (rows + 1.4, cols / 3), (2.5, cols + 1.6)]:
            points.append(list(cam.project(col, row, 0.0)))
        for p in points:
            picks.append({"heights": name, "px": p, "hold": None,
                          "pin": None if (q := cam.pick(p, heights)) is None else list(q)})
        # A press on a tall pin keeps it while it sinks.
        r, c = rows - 2, min(2, cols - 1)
        top = dict(cam.faces(r, c, 1.0))["top"]
        p = middle(top)
        for hold in (None, [[r, c], 1.0], [[r, c], 0.2]):
            q = cam.pick(p, heights, None if hold is None else ((hold[0][0], hold[0][1]), hold[1]))
            picks.append({"heights": name, "px": p, "hold": hold, "pin": None if q is None else list(q)})
        # A press that began in a gap belongs to its cell of the floor, whatever rises in front of it.
        for row, col in [(rows - 2 + 0.95, min(2, cols - 1) + 0.5), (1.03, cols / 2 + 0.5), (rows / 2 + 0.96, 0.5)]:
            p = list(cam.project(col, row, 0.0))
            own = [int(row), int(col)]
            for hold in (None, [own, 0.0], [own, 0.9], [[int(row) + 1 if int(row) + 1 < rows else 0, int(col)], 0.6]):
                q = cam.pick(p, heights, None if hold is None else ((hold[0][0], hold[0][1]), hold[1]))
                picks.append({"heights": name, "px": p, "hold": hold, "pin": None if q is None else list(q)})
    out["patterns"] = patterns(rows, cols)
    out["pick"] = picks
    return out


def main():
    cases = [case((1280, 800), False), case((1280, 800), True), case((1920, 1080), False),
             case((800, 600), False), case((2560, 1440), True), case((200, 160), False),
             case((1100, 760), False, rows=5, cols=7)]
    constants = {name: getattr(camera, name) for name in
                 ("ELEVATION_DEG", "DISTANCE", "RISE", "PIN", "PLATE_MARGIN", "PLATE_DEPTH", "FAR")}
    path = HERE / "camera.json"
    path.write_text(json.dumps({"constants": constants, "cases": cases}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
