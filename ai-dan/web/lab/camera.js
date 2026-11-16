// The fixed 3D view: where a point of the room lands on the screen, and back.
// A port of lab/camera.py, line for line, checked against the same numbers
// (tests/camera.test.js, tests/fixtures/camera.json).
//
// World coordinates are in pin units. `x` runs along the columns (0 at the
// left edge of the grid), `y` along the rows (0 at the back edge: row 0 is at
// the top of the top view) and `z` is height above the plate. A pin at real
// height `h` stands `h * RISE` tall.
//
// The camera stands in front of the body, beyond the last row and centred on
// the columns, and looks down at the centre of the grid from ELEVATION_DEG
// above the plate: where a person at the display would stand. It never moves:
// no orbit, no zoom, no animated change of view.

import { pyMax, pyMin } from "./py.js";

export const ELEVATION_DEG = 50.0;   // how steeply the camera looks down at the centre of the grid
export const DISTANCE = 2.6;         // from the centre of the grid to the camera, in grid sides
export const RISE = 1.8;             // how tall a pin stands at height 1, in pin units
export const PIN = 0.78;             // a pin's side, in pin units (a cell is 1)
export const PLATE_MARGIN = 0.35;    // the plate reaches this far beyond the grid, as in the top view
export const PLATE_DEPTH = 0.22;     // the plate's front edge, below the plate
export const FAR = 4.0;              // a pointer ray that misses the floor stops at FAR * distance

/** A real height from a [row][column] matrix, clipped to 0..1; 0 if missing. */
export function height(heights, r, c) {
  const v = Number(heights?.[r]?.[c]);
  if (Number.isNaN(v)) return 0.0;
  return Math.min(1.0, Math.max(0.0, v));
}

/** Whether a screen point is inside a convex quadrilateral (either winding,
 * edges included). A quadrilateral flattened to a line contains nothing. */
export function insideQuad(p, quad) {
  const [x, y] = p;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return sign !== 0;
}

export class Camera {
  /**
   * Fit the body (the plate, and every pin at full height) so its screen box
   * is `height` pixels tall, or narrower if it would be wider than
   * `maxWidth`, with the box centred on `center` ([x, y]).
   */
  constructor(rows, cols, center, height, maxWidth) {
    this.rows = rows;
    this.cols = cols;
    const el = ELEVATION_DEG * (Math.PI / 180);   // Python's math.radians
    this.cosEl = Math.cos(el);
    this.sinEl = Math.sin(el);
    this.distance = DISTANCE * Math.max(rows, cols);
    this.x = cols / 2;
    this.y = rows / 2 + this.distance * this.cosEl;
    this.z = this.distance * this.sinEl;
    const xs = [];
    const ys = [];
    for (const [x, y, z] of this._extent()) {
      const [u, v] = this._lens(x, y, z);
      xs.push(u);
      ys.push(v);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    this.k = Math.max(1.0, height) / spanY;
    if (this.k * spanX > Math.max(1.0, maxWidth)) this.k = Math.max(1.0, maxWidth) / spanX;
    this.ox = center[0] - this.k * (minX + maxX) / 2;
    this.oy = center[1] + this.k * (minY + maxY) / 2;
  }

  /** The corners of everything that can be drawn: the plate, and the pins at full height. */
  _extent() {
    const m = PLATE_MARGIN;
    const out = [];
    for (const x of [-m, this.cols + m]) {
      for (const y of [-m, this.rows + m]) {
        for (const z of [-PLATE_DEPTH, 0.0]) out.push([x, y, z]);
      }
    }
    for (const x of [0, this.cols]) {
      for (const y of [0, this.rows]) out.push([x, y, RISE]);
    }
    return out;
  }

  /** A world point on the camera's image plane, before scaling to pixels. */
  _lens(x, y, z) {
    const vx = x - this.x;
    const vy = y - this.y;
    const vz = z - this.z;
    const depth = Math.max(-vy * this.cosEl - vz * this.sinEl, 1e-6);
    const up = -vy * this.sinEl + vz * this.cosEl;
    return [vx / depth, up / depth];
  }

  // --- the room on the screen
  /** World point -> screen pixels [x, y]. */
  project(x, y, z) {
    const [u, v] = this._lens(x, y, z);
    return [this.ox + this.k * u, this.oy - this.k * v];
  }

  /**
   * Screen pixels -> [row, column] of the point of the floor under them.
   * Where the pointer is, in pin units, past 0..rows and 0..cols around the
   * body. It does not depend on the pins' heights.
   */
  floor(px) {
    const u = (px[0] - this.ox) / this.k;
    const v = (this.oy - px[1]) / this.k;
    const dx = u;
    const dy = -this.cosEl - v * this.sinEl;
    const dz = -this.sinEl + v * this.cosEl;
    const n = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const far = FAR * this.distance;
    let t = dz < 0 ? -this.z * n / dz : far;      // how far along the ray the floor is
    t = Math.min(t, far);
    return [this.y + t * dy / n, this.x + t * dx / n];
  }

  /**
   * Every pin as [row, column], in drawing order: the back row first, and in
   * each row from the outer columns in toward the camera, so that nearer
   * faces are drawn over farther ones.
   */
  order() {
    const dist = (c) => Math.abs(c + 0.5 - this.x);
    const cols = Array.from({ length: this.cols }, (_, c) => c)
      .sort((a, b) => (dist(b) - dist(a)) || (a - b));
    const out = [];
    for (let r = 0; r < this.rows; r++) for (const c of cols) out.push([r, c]);
    return out;
  }

  /**
   * The faces of pin (r, c) at real height h that the camera sees, as
   * [kind, [four screen points]], in drawing order. `kind` is "left" or
   * "right" (a side, by which way it faces), "front" or "top". A pin at
   * height 0 shows only its top, flush with the plate.
   */
  faces(r, c, h) {
    const z = pyMin(1.0, pyMax(0.0, h)) * RISE;   // Python's min and max: NaN becomes 0
    const a = (1 - PIN) / 2;
    const x0 = c + a;
    const x1 = c + 1 - a;
    const y0 = r + a;
    const y1 = r + 1 - a;
    const p = (x, y, zz) => this.project(x, y, zz);
    const out = [];
    if (z > 0) {
      if (this.x < x0) {
        out.push(["left", [p(x0, y0, z), p(x0, y1, z), p(x0, y1, 0.0), p(x0, y0, 0.0)]]);
      } else if (this.x > x1) {
        out.push(["right", [p(x1, y1, z), p(x1, y0, z), p(x1, y0, 0.0), p(x1, y1, 0.0)]]);
      }
      out.push(["front", [p(x0, y1, z), p(x1, y1, z), p(x1, y1, 0.0), p(x0, y1, 0.0)]]);
    }
    out.push(["top", [p(x0, y0, z), p(x1, y0, z), p(x1, y1, z), p(x0, y1, z)]]);
    return out;
  }

  /** [top, front edge] of the plate, four screen points each. */
  plate() {
    const m = PLATE_MARGIN;
    const { rows, cols } = this;
    const d = PLATE_DEPTH;
    const p = (x, y, z) => this.project(x, y, z);
    const top = [p(-m, -m, 0.0), p(cols + m, -m, 0.0), p(cols + m, rows + m, 0.0), p(-m, rows + m, 0.0)];
    const front = [p(-m, rows + m, 0.0), p(cols + m, rows + m, 0.0), p(cols + m, rows + m, -d), p(-m, rows + m, -d)];
    return [top, front];
  }

  /** [x, y, width, height] of the screen box the body can occupy. */
  bounds() {
    const pts = this._extent().map(([x, y, z]) => this.project(x, y, z));
    const xs = pts.map(([x]) => x);
    const ys = pts.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
  }

  // --- the screen back to the room
  /** Whether pin (r, c), drawn at height h, covers screen point px. */
  covers(px, r, c, h) {
    return this.faces(r, c, h).some(([, quad]) => insideQuad(px, quad));
  }

  /** The cell [row, column] of the floor point under px; null off the grid. */
  cell(px) {
    const [row, col] = this.floor(px);
    if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) return [Math.trunc(row), Math.trunc(col)];
    return null;
  }

  /**
   * The pin under screen point px, as drawn with `heights`.
   *
   * `hold` is [[row, column], height]: a press already on that pin. It keeps
   * the pin while px is inside the pin's outline at that height, or over the
   * pin's own cell of the floor: how the pin stood when the press began and
   * where it is, never what it has done since. So the pin sinking under the
   * press, or its neighbours moving, cannot move the touch. Otherwise: the
   * nearest pin whose outline contains px; then the cell of the floor point
   * under px, so the gaps between pins belong to a pin as in the top view;
   * null when that point is off the grid.
   */
  pick(px, heights, hold = null) {
    if (hold !== null) {
      const [[r, c], h] = hold;
      const own = this.cell(px);
      if (this.covers(px, r, c, h) || (own !== null && own[0] === r && own[1] === c)) return [r, c];
    }
    const order = this.order();
    for (let i = order.length - 1; i >= 0; i--) {
      const [r, c] = order[i];
      if (this.covers(px, r, c, height(heights, r, c))) return [r, c];
    }
    return this.cell(px);
  }
}
