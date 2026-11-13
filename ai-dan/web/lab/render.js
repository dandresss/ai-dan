// Drawing the room: a function of a body snapshot and a little view state.
// A port of lab/render.py to a 2D canvas.
//
// The honesty rule lives here. Every visual property of a pin (brightness,
// size, glow, shadow) is computed from that pin's real height and the body's
// colour, and from nothing else: no clocks, no noise, no light from the person.
// If the body looks like it is breathing, the mind made it breathe.
//
// The pure parts (layout, mindStatus, the observer's reading of the feed) run
// in Node for the tests; nothing touches the DOM at import time.

import {
  BLACK, DORMANT, GHOST, PERSON, PLATE, PLATE_EDGE, ROOM_CENTER, ROOM_EDGE, WHITE,
  canvasMeasure, css, dot, mix, ring, roundRect,
} from "./render-base.js";
import { drawBanners, drawHelp, drawIntro, drawSaid, drawStatus, isWiringTest } from "./render-chrome.js";
import { Observer, drawPanel } from "./render-panel.js";

export { Observer } from "./render-panel.js";
export { callLine, entryItems, playSummary } from "./render-panel.js";
export { isWiringTest, mindFailing, mindStatus, statusY, tokenText, typingY } from "./render-chrome.js";
export { clock } from "./render-base.js";

const intOf = (v) => Math.trunc(v);

// --- view state ----------------------------------------------------------
/** Everything the drawing needs besides the body itself (render.View). */
export function makeView(over = {}) {
  return {
    mode: "live",            // live, dryrun, replay, nokey
    observer: new Observer(),
    panel: false,            // Tab
    help: false,             // F1
    clean: false,            // F2: no chrome
    intro: 1.0,              // opacity of the title overlay
    said: "",
    saidAlpha: 0.0,
    cursor: null,            // the pointer in CSS px, while the person is in the room
    pressing: false,
    logName: null,           // live and wiring test: the log's file name
    nokeyDetail: null,       // why there is no mind
    replayName: null,
    replayProgress: 0.0,
    replayTotal: 0.0,
    replayCheck: null,       // {mismatches, states, calls} once a replay has ended
    paused: false,
    speed: 1.0,
    // The page's additions
    touch: false,            // the visitor uses a touch screen: words change, keys do not apply
    keysLeft: null,          // left edge of the page's buttons on the status line, in px
    statusLift: 0,           // px the status line moves up when the buttons sit below it
    panelScroll: 0,          // px the observer panel is scrolled back
    aside: false,            // keep the panel's place clear without drawing it (the start card sits there)
    ...over,
  };
}

/** A body at rest: what the room shows before any session has a body. */
export function restingSnapshot(rows = 8, cols = 8) {
  const zeros = () => Array.from({ length: rows }, () => new Array(cols).fill(0));
  return { tick: 0, t: 0, rows, cols, target: zeros(), actual: zeros(), gap_max: zeros(),
    color: [255, 255, 255], person: null, pressed: null };
}

// --- layout --------------------------------------------------------------
function rect(x, y, w, h) {
  return { x, y, w, h, right: x + w, bottom: y + h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) };
}

export class Layout {
  constructor(fields) {
    Object.assign(this, fields);
  }

  /** CSS px -> [row, column] in pin units, past 0..8 in the margin. */
  toPinUnits(px) {
    return [(px[1] - this.grid.y) / this.pitch, (px[0] - this.grid.x) / this.pitch];
  }

  toPixels(pos) {
    return [this.grid.x + pos[1] * this.pitch, this.grid.y + pos[0] * this.pitch];
  }

  pinAt(px, rows = 8, cols = 8) {
    const [r, c] = this.toPinUnits(px);
    if (r >= 0 && r < rows && c >= 0 && c < cols) return [Math.trunc(r), Math.trunc(c)];
    return null;
  }
}

/**
 * render.layout. On a wide window it is the desktop's, to the pixel. On a
 * narrow portrait screen (a phone) the panel goes below the room instead of
 * beside it, and the grid takes more of the width.
 */
export function layout(size, panel, rows = 8, cols = 8) {
  const w = Math.max(Math.floor(size.width), 200);
  const h = Math.max(Math.floor(size.height), 160);
  const u = Math.max(0.75, Math.min(w / 1100, h / 760, 1.8));
  const compact = w < 600 && h >= w;
  let panelRect = null;
  let panelSide = null;
  let room = rect(0, 0, w, h);
  if (panel && compact) {
    const ph = intOf(h * 0.45);
    panelRect = rect(0, h - ph, w, ph);
    panelSide = "bottom";
    room = rect(0, 0, w, h - ph);
  } else if (panel) {
    const pw = intOf(Math.min(Math.max(w * 0.38, 340), w * 0.55));
    panelRect = rect(w - pw, 0, pw, h);
    panelSide = "right";
    room = rect(0, 0, w - pw, h);
  }
  // The margin around the grid is where the person stands: keep it generous.
  const pitch = compact
    ? Math.min(room.w / (cols + 3.0), room.h / (rows + 6.5))
    : Math.min(room.w / (cols + 5.5), h / (rows + 5.0));
  const gw = intOf(pitch * cols);
  const gh = intOf(pitch * rows);
  const centerY = compact ? intOf(room.h * 0.45) : intOf(h * 0.48);
  const grid = rect(room.cx - Math.floor(gw / 2), centerY - Math.floor(gh / 2), gw, gh);
  return new Layout({ width: w, height: h, room, grid, pitch, panel: panelRect, panelSide, u,
    dpr: size.dpr || 1, compact });
}

// --- the room ------------------------------------------------------------
let roomImage = null;

// Near-black floor, a touch lighter where the body is. Drawn small and
// scaled, as the desktop does.
function roomTexture() {
  if (roomImage) return roomImage;
  const sw = 128;
  const sh = 80;
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(sw, sh) : Object.assign(document.createElement("canvas"), { width: sw, height: sh });
  const g = canvas.getContext("2d");
  const img = g.createImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const d = Math.hypot((x - sw / 2) / (sw / 2), (y - sh * 0.48) / (sh / 2)) / 1.2;
      const c = mix(ROOM_CENTER, ROOM_EDGE, Math.min(1, d) ** 1.3);
      const i = (y * sw + x) * 4;
      img.data.set([c[0], c[1], c[2], 255], i);
    }
  }
  g.putImageData(img, 0, 0);
  roomImage = canvas;
  return roomImage;
}

function drawRoom(ctx, lay) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(roomTexture(), lay.room.x, lay.room.y, lay.room.w, lay.room.h);
}

// --- the body ------------------------------------------------------------
function height(snap, r, c) {
  const v = Number(snap.actual?.[r]?.[c]);
  if (Number.isNaN(v)) return 0.0;
  return Math.min(1.0, Math.max(0.0, v));
}

/** Brightness grows with real height; at 0 the pin is dark but present. */
export function pinFace(h, tint) {
  const dormant = mix(DORMANT, tint, 0.05);
  const lit = mix(tint, WHITE, 0.12);
  return mix(dormant, lit, h ** 1.25);
}

// Python's round(): ties to even. Only used to quantise the glow as the
// desktop does, so both draw the same steps of light.
function roundEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d !== 0.5) return Math.round(x);
  return f % 2 === 0 ? f : f + 1;
}

const glowCaches = new WeakMap();   // per context: a gradient belongs to the canvas that made it

// The base of every glow: a disc whose light fades from the centre as
// (1 - d) ** 1.6, added to what is below it.
function glowGradient(ctx, diameter, rgb) {
  let cache = glowCaches.get(ctx);
  if (!cache) glowCaches.set(ctx, (cache = new Map()));
  const key = `${diameter}|${rgb}`;
  let g = cache.get(key);
  if (!g) {
    if (cache.size > 600) cache.clear();
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, diameter / 2);
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const d = i / steps;
      g.addColorStop(d, css(rgb, Math.max(0, 1 - d) ** 1.6));
    }
    cache.set(key, g);
  }
  return g;
}

export function drawBody(ctx, snap, lay) {
  const p = lay.pitch;
  const { rows, cols } = snap;
  const snapPx = (v) => Math.round(v * lay.dpr) / lay.dpr;
  const tint = [0, 1, 2].map((i) => intOf(Math.min(255, Math.max(0, Number(snap.color?.[i]) || 0))));

  const grow = intOf(p * 0.7);
  const plateX = lay.grid.x - Math.floor(grow / 2);
  const plateY = lay.grid.y - Math.floor(grow / 2);
  const plateR = intOf(p * 0.18);
  roundRect(ctx, plateX, plateY, lay.grid.w + grow, lay.grid.h + grow, plateR);
  ctx.fillStyle = css(PLATE);
  ctx.fill();
  roundRect(ctx, plateX + 0.5, plateY + 0.5, lay.grid.w + grow - 1, lay.grid.h + grow - 1, plateR);
  ctx.strokeStyle = css(PLATE_EDGE);
  ctx.lineWidth = 1;
  ctx.stroke();

  const heights = [];
  for (let r = 0; r < rows; r++) {
    heights.push([]);
    for (let c = 0; c < cols; c++) heights[r].push(height(snap, r, c));
  }
  const center = (r, c) => [lay.grid.x + (c + 0.5) * p, lay.grid.y + (r + 0.5) * p];
  const square = (r, c, h) => {
    const side = p * (0.70 + 0.14 * h);
    const [cx, cy] = center(r, c);
    return [snapPx(cx - side / 2), snapPx(cy - side / 2), snapPx(side)];
  };
  const radius = Math.max(1, intOf(p * 0.06));

  // Shadows: a raised pin is lit from above-left and shades the plate.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r][c];
      if (h <= 0.01) continue;
      const [x, y, s] = square(r, c, h);
      roundRect(ctx, x + snapPx(p * 0.07 * h), y + snapPx(p * 0.11 * h), s, s, radius);
      ctx.fillStyle = css(mix(PLATE, BLACK, 0.75 * Math.min(1, h * 1.5)));
      ctx.fill();
    }
  }

  // Glow: light from a raised pin spills onto the plate around it.
  const gd = Math.max(4, intOf(p * 2.4));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r][c];
      if (h <= 0.02) continue;
      const level = roundEven(h ** 1.5 * 20) / 20;
      if (level <= 0) continue;
      const rgb = tint.map((v) => intOf(v * 0.30 * level));
      const [cx, cy] = center(r, c);
      ctx.setTransform(lay.dpr, 0, 0, lay.dpr, cx * lay.dpr, cy * lay.dpr);
      ctx.fillStyle = glowGradient(ctx, gd, rgb);
      ctx.fillRect(-gd / 2, -gd / 2, gd, gd);
    }
  }
  ctx.restore();

  // Faces, with a thin lit edge that grows with height.
  ctx.lineWidth = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r][c];
      const [x, y, s] = square(r, c, h);
      const face = pinFace(h, tint);
      roundRect(ctx, x, y, s, s, radius);
      ctx.fillStyle = css(face);
      ctx.fill();
      roundRect(ctx, x + 0.5, y + 0.5, s - 1, s - 1, radius);
      ctx.strokeStyle = css(mix(face, WHITE, 0.05 + 0.2 * h));
      ctx.stroke();
    }
  }
}

/** The person: a warm light at the pointer (live), or the recorded visitor
 * as a ring (replay). It lights the room, never the pins. */
export function drawPerson(ctx, lay, px, pressing, ghost = false) {
  const p = lay.pitch;
  const x = intOf(px[0]) + 0.5;
  const y = intOf(px[1]) + 0.5;
  if (ghost) {
    const r = Math.max(5, intOf(p * 0.16));
    ring(ctx, x, y, r, mix(BLACK, GHOST, 0.55));
    dot(ctx, x, y, 2, GHOST);
    if (pressing) ring(ctx, x, y, Math.max(3, intOf(r * 0.55)), GHOST);
    return;
  }
  const d = Math.max(16, intOf(p * (pressing ? 0.8 : 1.3)));
  const peak = (pressing ? 170 : 110) / 255;
  const halo = ctx.createRadialGradient(x, y, 0, x, y, d / 2);
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    halo.addColorStop(k, css(PERSON, peak * Math.max(0, 1 - k) ** 2.8));
  }
  ctx.fillStyle = halo;
  ctx.fillRect(x - d / 2, y - d / 2, d, d);
  dot(ctx, x, y, Math.max(2, intOf(p * 0.035)), PERSON);
  if (pressing) ring(ctx, x, y, Math.max(5, intOf(p * 0.13)), PERSON);   // a small mark at the fingertip
}

// --- the whole frame -----------------------------------------------------
const measures = new WeakMap();

/**
 * Draw one frame on a canvas whose backing store is size.width x size.height
 * CSS px at size.dpr. Returns the layout, so input can map pixels to pins;
 * `layout.panelInfo` says how far the observer panel can scroll.
 */
export function draw(ctx, snap, view, size) {
  let measure = measures.get(ctx);
  if (!measure) {
    measure = canvasMeasure(ctx);
    measures.set(ctx, measure);
  }
  const rows = snap ? snap.rows : 8;
  const cols = snap ? snap.cols : 8;
  const lay = layout(size, (view.panel && !view.clean) || view.aside, rows, cols);
  ctx.setTransform(lay.dpr, 0, 0, lay.dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = css(ROOM_EDGE);
  ctx.fillRect(0, 0, size.width, size.height);
  drawRoom(ctx, lay);
  if (snap) drawBody(ctx, snap, lay);

  // The person. Live: the pointer itself. Replay: the recorded visitor as a ghost.
  if (view.mode === "replay") {
    if (snap?.person) drawPerson(ctx, lay, lay.toPixels(snap.person), snap.pressed != null, true);
  } else if (view.cursor) {
    drawPerson(ctx, lay, view.cursor, view.pressing);
  }

  lay.panelInfo = null;
  if (view.clean) {
    if (isWiringTest(view)) drawBanners(ctx, lay, snap, makeView({ mode: "dryrun" }), measure);   // never let a recording of a wiring test pass for an AI
    return lay;
  }
  drawIntro(ctx, lay, view, measure);
  drawBanners(ctx, lay, snap, view, measure);
  if (view.mode !== "replay") drawSaid(ctx, lay, view, measure);
  drawStatus(ctx, lay, snap, view, measure);
  lay.panelInfo = drawPanel(ctx, lay, view, measure);
  if (view.help) drawHelp(ctx, lay, view, measure);
  return lay;
}
