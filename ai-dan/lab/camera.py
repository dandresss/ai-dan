"""The fixed 3D view: where a point of the room lands on the screen, and back.

Plain arithmetic, no pygame, so the page ports it line for line
(`web/lab/camera.js`) and both are checked against the same numbers.

World coordinates are in pin units. `x` runs along the columns (0 at the left
edge of the grid), `y` along the rows (0 at the back edge: row 0 is at the top
of the top view) and `z` is height above the plate. A pin at real height `h`
stands `h * RISE` tall.

The camera stands in front of the body, beyond the last row and centred on the
columns, and looks down at the centre of the grid from `ELEVATION_DEG` above
the plate: where a person at the display would stand. It never moves: no
orbit, no zoom, no animated change of view.
"""
from __future__ import annotations

import math

ELEVATION_DEG = 50.0   # how steeply the camera looks down at the centre of the grid
DISTANCE = 2.6         # from the centre of the grid to the camera, in grid sides
RISE = 1.8             # how tall a pin stands at height 1, in pin units
PIN = 0.78             # a pin's side, in pin units (a cell is 1)
PLATE_MARGIN = 0.35    # the plate reaches this far beyond the grid, as in the top view
PLATE_DEPTH = 0.22     # the plate's front edge, below the plate
FAR = 4.0              # a pointer ray that misses the floor stops at FAR * distance


def height(heights, r: int, c: int) -> float:
    """A real height from a [row][column] matrix, clipped to 0..1; 0 if missing."""
    try:
        return min(1.0, max(0.0, float(heights[r][c])))
    except (IndexError, TypeError, ValueError):
        return 0.0


def inside_quad(p, quad) -> bool:
    """Whether a screen point is inside a convex quadrilateral (either winding,
    edges included). A quadrilateral flattened to a line contains nothing."""
    x, y = p
    sign = 0
    for i in range(4):
        ax, ay = quad[i]
        bx, by = quad[(i + 1) % 4]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if cross != 0:
            s = 1 if cross > 0 else -1
            if sign == 0:
                sign = s
            elif s != sign:
                return False
    return sign != 0


class Camera:
    def __init__(self, rows: int, cols: int, center: tuple, height: float, max_width: float):
        """Fit the body (the plate, and every pin at full height) so its screen
        box is `height` pixels tall, or narrower if it would be wider than
        `max_width`, with the box centred on `center`."""
        self.rows, self.cols = rows, cols
        el = math.radians(ELEVATION_DEG)
        self.cos_el, self.sin_el = math.cos(el), math.sin(el)
        self.distance = DISTANCE * max(rows, cols)
        self.x = cols / 2
        self.y = rows / 2 + self.distance * self.cos_el
        self.z = self.distance * self.sin_el
        xs, ys = [], []
        for x, y, z in self._extent():
            u, v = self._lens(x, y, z)
            xs.append(u)
            ys.append(v)
        span_x, span_y = max(xs) - min(xs), max(ys) - min(ys)
        self.k = max(1.0, height) / span_y
        if self.k * span_x > max(1.0, max_width):
            self.k = max(1.0, max_width) / span_x
        self.ox = center[0] - self.k * (min(xs) + max(xs)) / 2
        self.oy = center[1] + self.k * (min(ys) + max(ys)) / 2

    def _extent(self) -> list:
        """The corners of everything that can be drawn: the plate, and the pins at full height."""
        m, rows, cols = PLATE_MARGIN, self.rows, self.cols
        plate = [(x, y, z) for x in (-m, cols + m) for y in (-m, rows + m) for z in (-PLATE_DEPTH, 0.0)]
        pins = [(x, y, RISE) for x in (0, cols) for y in (0, rows)]
        return plate + pins

    def _lens(self, x: float, y: float, z: float) -> tuple:
        """A world point on the camera's image plane, before scaling to pixels."""
        vx, vy, vz = x - self.x, y - self.y, z - self.z
        depth = max(-vy * self.cos_el - vz * self.sin_el, 1e-6)
        up = -vy * self.sin_el + vz * self.cos_el
        return vx / depth, up / depth

    # --- the room on the screen -------------------------------------------
    def project(self, x: float, y: float, z: float) -> tuple:
        """World point -> screen pixels."""
        u, v = self._lens(x, y, z)
        return (self.ox + self.k * u, self.oy - self.k * v)

    def floor(self, px) -> tuple:
        """Screen pixels -> (row, column) of the point of the floor under them.
        Where the pointer is, in pin units, past 0..rows and 0..cols around the
        body. It does not depend on the pins' heights."""
        u = (px[0] - self.ox) / self.k
        v = (self.oy - px[1]) / self.k
        dx = u
        dy = -self.cos_el - v * self.sin_el
        dz = -self.sin_el + v * self.cos_el
        n = math.sqrt(dx * dx + dy * dy + dz * dz)
        far = FAR * self.distance
        t = -self.z * n / dz if dz < 0 else far      # how far along the ray the floor is
        t = min(t, far)
        return (self.y + t * dy / n, self.x + t * dx / n)

    def order(self) -> list:
        """Every pin as (row, column), in drawing order: the back row first, and
        in each row from the outer columns in toward the camera, so that nearer
        faces are drawn over farther ones."""
        cols = sorted(range(self.cols), key=lambda c: (-abs(c + 0.5 - self.x), c))
        return [(r, c) for r in range(self.rows) for c in cols]

    def faces(self, r: int, c: int, h: float) -> list:
        """The faces of pin (r, c) at real height h that the camera sees, as
        (kind, [four screen points]), in drawing order. `kind` is "left" or
        "right" (a side, by which way it faces), "front" or "top". A pin at
        height 0 shows only its top, flush with the plate."""
        z = min(1.0, max(0.0, h)) * RISE
        a = (1 - PIN) / 2
        x0, x1 = c + a, c + 1 - a
        y0, y1 = r + a, r + 1 - a
        p = self.project
        out = []
        if z > 0:
            if self.x < x0:
                out.append(("left", [p(x0, y0, z), p(x0, y1, z), p(x0, y1, 0.0), p(x0, y0, 0.0)]))
            elif self.x > x1:
                out.append(("right", [p(x1, y1, z), p(x1, y0, z), p(x1, y0, 0.0), p(x1, y1, 0.0)]))
            out.append(("front", [p(x0, y1, z), p(x1, y1, z), p(x1, y1, 0.0), p(x0, y1, 0.0)]))
        out.append(("top", [p(x0, y0, z), p(x1, y0, z), p(x1, y1, z), p(x0, y1, z)]))
        return out

    def plate(self) -> tuple:
        """(top, front edge) of the plate, four screen points each."""
        m, rows, cols, d = PLATE_MARGIN, self.rows, self.cols, PLATE_DEPTH
        p = self.project
        top = [p(-m, -m, 0.0), p(cols + m, -m, 0.0), p(cols + m, rows + m, 0.0), p(-m, rows + m, 0.0)]
        front = [p(-m, rows + m, 0.0), p(cols + m, rows + m, 0.0), p(cols + m, rows + m, -d), p(-m, rows + m, -d)]
        return top, front

    def bounds(self) -> tuple:
        """(x, y, width, height) of the screen box the body can occupy."""
        pts = [self.project(*corner) for corner in self._extent()]
        xs = [x for x, _ in pts]
        ys = [y for _, y in pts]
        return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))

    # --- the screen back to the room --------------------------------------
    def covers(self, px, r: int, c: int, h: float) -> bool:
        """Whether pin (r, c), drawn at height h, covers screen point px."""
        return any(inside_quad(px, quad) for _, quad in self.faces(r, c, h))

    def cell(self, px) -> tuple | None:
        """The cell (row, column) of the floor point under px; None off the grid."""
        row, col = self.floor(px)
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return (int(row), int(col))
        return None

    def pick(self, px, heights, hold=None) -> tuple | None:
        """The pin under screen point px, as drawn with `heights`.

        `hold` is ((row, column), height): a press already on that pin. It keeps
        the pin while px is inside the pin's outline at that height, or over the
        pin's own cell of the floor: how the pin stood when the press began and
        where it is, never what it has done since. So the pin sinking under the
        press, or its neighbours moving, cannot move the touch. Otherwise: the
        nearest pin whose outline contains px; then the cell of the floor point
        under px, so the gaps between pins belong to a pin as in the top view;
        None when that point is off the grid."""
        if hold is not None:
            (r, c), h = hold
            if self.covers(px, r, c, h) or self.cell(px) == (r, c):
                return (r, c)
        for r, c in reversed(self.order()):
            if self.covers(px, r, c, height(heights, r, c)):
                return (r, c)
        return self.cell(px)
