// The observer: what the page knows of the mind (read from the event feed),
// and the panel that shows its private side. Ports Observer, _play_summary,
// _call_line, _entry_surface and draw_panel from render.py.
//
// The functions that turn events into text and boxes are pure, so tests run
// them in Node; drawing takes a canvas context.

import {
  ASLEEP, AWAKE, BLACK, GONE, PANEL_BG, TEXT, TEXT_DIM, TEXT_FAINT, THOUGHT, VOICE, WARN,
  clock, css, drawText, fixed, floatText, font, formatG, mix, pyFloat, pyJson, pyRepr, roundRect, truthy, wrap,
} from "./render-base.js";

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => isDict(obj) && Object.hasOwn(obj, key);
const get = (obj, key, fallback = null) => (has(obj, key) ? obj[key] : fallback);
const intOf = (v) => Math.trunc(v);

// --- reading the feed ----------------------------------------------------
/** Reads the event feed and keeps what the page shows of the mind: its state
 * for the status line and the entries for the observer panel. */
export class Observer {
  constructor() {
    this.index = 0;
    this.header = null;
    this.status = "starting";     // starting, none, waiting, awake, asleep, ended
    this.turn = 0;
    this.wakeT = null;
    this.callsThisTurn = 0;
    this.errorsInARow = 0;
    this.lastError = null;
    this.close = null;
    this.arrived = false;
    this.entries = [];            // {seq, ev}
    this._seq = 0;
    // The page's additions: tokens spent so far, and whether the last turn
    // ended without an answer (a wrong key fails once per turn, not four times).
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.lastTurnFailed = false;
  }

  get mind() {
    return this.header ? get(this.header, "mind") : null;
  }

  read(feed) {
    const events = feed.since(this.index);
    this.index += events.length;
    for (const ev of events) this.add(ev);
  }

  add(ev) {
    switch (get(ev, "type")) {
      case "header":
        this.header = ev;
        this.status = ev.mind === "none" ? "none" : "waiting";
        break;
      case "person":
        if (get(ev, "pos") !== null) this.arrived = true;
        break;
      case "wake":
        this.status = "awake";
        this.turn = get(ev, "turn", this.turn + 1);
        this.wakeT = get(ev, "t", 0.0);
        this.callsThisTurn = 0;
        this.lastTurnFailed = false;
        this._entry(ev);
        break;
      case "turn_end":
        if (this.status !== "ended") this.status = "asleep";
        this.lastTurnFailed = truthy(ev.skipped) && this.errorsInARow > 0;
        this._entry(ev);
        break;
      case "close":
        this.status = "ended";
        this.close = ev;
        this._entry(ev);
        break;
      case "api_error":
        this.errorsInARow += 1;
        this.lastError = String(get(ev, "error", ""));
        this._entry(ev);
        break;
      case "usage":
        this.errorsInARow = 0;
        this.inputTokens += Number(ev.input_tokens) || 0;
        this.outputTokens += Number(ev.output_tokens) || 0;
        break;
      case "call":
        this.callsThisTurn += 1;
        this._entry(ev);
        break;
      case "thought":
      case "voice":
        this._entry(ev);
        break;
      default:
        break;
    }
  }

  _entry(ev) {
    this._seq += 1;
    this.entries.push({ seq: this._seq, ev });
    if (this.entries.length > 400) this.entries.splice(0, 100);
  }
}

// --- one call as a line --------------------------------------------------
// Python indexing: lists and strings, negative indices; anything else raises.
function at(seq, i) {
  const items = typeof seq === "string" ? [...seq] : seq;
  if (!Array.isArray(items)) throw new TypeError("not subscriptable");
  const j = i < 0 ? items.length + i : i;
  if (j < 0 || j >= items.length) throw new RangeError("index out of range");
  return items[j];
}

/** render._play_summary: (text, keyframe curves). */
export function playSummary(args) {
  const tracks = isDict(args) ? get(args, "tracks") : null;
  if (!Array.isArray(tracks)) return ["play", []];
  const parts = [];
  const curves = [];
  for (const tr of tracks) {
    if (!isDict(tr)) continue;
    const pins = get(tr, "pins");
    const n = pins === "all" ? 64 : (Array.isArray(pins) ? pins.length : "?");
    const kfs = Array.isArray(get(tr, "keyframes")) ? tr.keyframes : [];
    let period;
    let pts;
    try {
      period = pyFloat(at(at(kfs, -1), 0));
      pts = kfs.map((k) => [pyFloat(at(k, 0)), pyFloat(at(k, 1))]);
    } catch {
      period = null;
      pts = [];
    }
    const bits = [`${n} pin${n !== 1 ? "s" : ""}`];
    bits.push(truthy(get(tr, "loop")) ? "loop" : "once");
    if (period !== null && truthy(period)) bits.push(`${formatG(period)} s`);
    const delay = get(tr, "delay_s");
    if (truthy(delay)) {
      bits.push(typeof delay === "number" || typeof delay === "boolean" ? `after ${formatG(Number(delay))} s` : "delayed");
    }
    parts.push(bits.join(" "));
    curves.push(pts);
  }
  const more = parts.length > 3 ? ` (+${parts.length - 3} more)` : "";
  const text = `play  ${parts.length} track${parts.length !== 1 ? "s" : ""}: ` + parts.slice(0, 3).join(";  ") + more;
  return [text, curves.slice(0, 4)];
}

function cellsOf(matrix) {
  if (!Array.isArray(matrix)) throw new TypeError("not a matrix");
  const cells = [];
  for (const row of matrix) {
    if (!Array.isArray(row)) throw new TypeError("not a row");
    for (const v of row) {
      if (typeof v !== "number" && typeof v !== "boolean") throw new TypeError("not a number");
      cells.push(Number(v));
    }
  }
  if (cells.length === 0) throw new RangeError("empty");
  return cells;
}

const personText = (p) =>
  Array.isArray(p) && p.every((v) => typeof v === "number") ? `[${p.map(floatText).join(", ")}]` : pyRepr(p);

function channel(v) {
  if (typeof v !== "number" && typeof v !== "boolean") throw new TypeError("not a number");
  const a = Number(v) > 0 ? Number(v) : 0;      // max(0, v)
  return intOf(a < 255 ? a : 255);              // int(min(255, a))
}

/** render._call_line: {line, curves, swatch} for one call event. */
export function callLine(ev) {
  const name = get(ev, "name", "?");
  const args = truthy(get(ev, "args")) ? ev.args : {};
  const res = truthy(get(ev, "result")) ? ev.result : {};
  if (name === "play") {
    const [line, curves] = playSummary(args);
    return { line, curves, swatch: null };
  }
  if (name === "sense") {
    const bits = ["sense"];
    if (has(res, "actual")) {
      try {
        const cells = cellsOf(res.actual);
        bits.push(`height ${fixed(Math.min(...cells), 2)}-${fixed(Math.max(...cells), 2)}`);
        bits.push(`gap max ${fixed(Math.max(...cellsOf(get(res, "gap", [[0]]))), 2)}`);
      } catch {
        // as in Python: whatever could not be read is left out
      }
      const person = get(res, "person");
      bits.push(truthy(person) ? `person ${personText(person)}` : "nobody");
    }
    return { line: bits.join(" · "), curves: [], swatch: null };
  }
  if (name === "set_color") {
    const rgb = isDict(args) ? get(args, "rgb") : null;
    let swatch = null;
    try {
      if (!Array.isArray(rgb)) throw new TypeError("not a list");
      swatch = rgb.slice(0, 3).map(channel);
    } catch {
      swatch = null;
    }
    return { line: `set_color  ${pyRepr(rgb)}`, curves: [], swatch };
  }
  if (name === "stop") {
    const pins = isDict(args) ? get(args, "pins") : null;
    const what = pins === null || pins === "all" ? "all pins" : `${Array.isArray(pins) ? pins.length : "?"} pins`;
    return { line: `stop  ${what}`, curves: [], swatch: null };
  }
  if (name === "remember") {
    const value = (isDict(args) ? Object.values(args) : []).find((v) => typeof v === "string") ?? "";
    return { line: `remember  “${value}”`, curves: [], swatch: null };
  }
  return { line: `${pyRepr(name)}  ${pyJson(args).slice(0, 80)}`, curves: [], swatch: null };
}

// --- one event as a block of the panel -----------------------------------
/**
 * render._entry_surface as data: the items of one block, each with its
 * height in px. `measure(font, text)` gives text widths.
 */
export function entryItems(ev, width, u, measure) {
  const body = font("sans", 17 * u);
  const italic = font("sans", 17 * u, true);
  const mono = font("mono", 15 * u);
  const small = font("sans", 14 * u);
  const kind = get(ev, "type");
  const items = [];
  const indent = intOf(12 * u);
  const gap = (h) => items.push({ kind: "gap", h });
  const addText = (f, s, color, w = width) => {
    for (const text of wrap(measure, f, s, w)) items.push({ kind: "text", f, text, color, h: f.lineH });
  };

  if (kind === "wake") {
    gap(intOf(14 * u));
    items.push({ kind: "rule", h: intOf(8 * u) });
    let heard = null;
    try {
      const msg = get(ev, "message");
      const data = typeof msg === "string" ? JSON.parse(msg) : msg;
      heard = isDict(data) ? get(data, "heard") : null;
    } catch {
      heard = null;
    }
    const reasons = Array.isArray(ev.reasons) ? ev.reasons.join(", ") : "";
    addText(small, `TURN ${pyRepr(get(ev, "turn", "?"))}   ·   woke at ${clock(get(ev, "t", 0))}`
      + (reasons ? `   ·   ${reasons}` : ""), AWAKE);
    if (truthy(heard)) {
      const list = typeof heard === "string" ? [...heard] : (Array.isArray(heard) ? heard : []);
      addText(body, "heard: " + list.map((h) => `“${pyRepr(h)}”`).join("  /  "), VOICE);
    }
  } else if (kind === "thought") {
    const thinking = ev.kind === "thinking";
    gap(intOf(4 * u));
    addText(thinking ? italic : body, String(get(ev, "text") || "").trim(), thinking ? mix(THOUGHT, BLACK, 0.22) : THOUGHT);
  } else if (kind === "call") {
    const res = truthy(get(ev, "result")) ? ev.result : {};
    const { line, curves, swatch } = callLine(ev);
    const failed = isDict(res) && res.ok === false;
    const sw = swatch && swatch.length ? intOf(12 * u) : 0;
    gap(intOf(3 * u));
    wrap(measure, mono, line, width - indent - (sw ? sw + 8 : 0)).forEach((text, i) => {
      items.push({ kind: "indent", f: mono, text, color: failed ? WARN : TEXT, swatch: i === 0 && sw ? swatch : null, h: mono.lineH });
    });
    if (failed) {
      for (const text of wrap(measure, mono, `refused: ${pyRepr(get(res, "error", ""))}`, width - indent)) {
        items.push({ kind: "indent", f: mono, text, color: WARN, swatch: null, h: mono.lineH });
      }
    }
    if (curves.length && !failed) items.push({ kind: "curves", curves, h: intOf(22 * u) + intOf(4 * u) });
  } else if (kind === "voice") {
    gap(intOf(6 * u));
    addText(body, `the person says “${pyRepr(get(ev, "text", ""))}”`, VOICE);
  } else if (kind === "api_error") {
    gap(intOf(4 * u));
    addText(mono, `API error, attempt ${pyRepr(get(ev, "attempt", "?"))}: ${pyRepr(get(ev, "error", ""))}`, WARN);
  } else if (kind === "turn_end") {
    const n = get(ev, "tool_calls", 0);
    let note = `asleep after ${pyRepr(n)} call${n !== 1 ? "s" : ""}`;
    if (truthy(ev.capped)) note += ", stopped at the cap";
    if (truthy(ev.skipped)) note += ", turn skipped";
    gap(intOf(5 * u));
    addText(small, note, ASLEEP);
  } else if (kind === "close") {
    gap(intOf(14 * u));
    addText(small, `SESSION ENDED   ·   ${pyRepr(get(ev, "reason", ""))}   ·   `
      + `${pyRepr(get(ev, "turns", "?"))} turns, ${pyRepr(get(ev, "input_tokens", 0))} in / `
      + `${pyRepr(get(ev, "output_tokens", 0))} out tokens`, GONE);
  }
  return { items, height: items.reduce((sum, it) => sum + it.h, 0) };
}

// --- drawing -------------------------------------------------------------
function drawBlock(ctx, items, x, y, width, u) {
  const indent = intOf(12 * u);
  for (const it of items) {
    if (it.kind === "text") {
      drawText(ctx, it.f, it.text, it.color, x, y);
    } else if (it.kind === "rule") {
      ctx.fillStyle = "rgb(34,34,42)";
      ctx.fillRect(x, y + 2, width, 1);
    } else if (it.kind === "indent") {
      let tx = x + indent;
      if (it.swatch && it.swatch.length === 3) {
        const s = intOf(12 * u);
        const by = y + intOf((it.h - s) / 2);
        roundRect(ctx, tx, by, s, s, 2);
        ctx.fillStyle = css(it.swatch);
        ctx.fill();
        roundRect(ctx, tx + 0.5, by + 0.5, s - 1, s - 1, 2);
        ctx.strokeStyle = "rgb(70,70,80)";
        ctx.lineWidth = 1;
        ctx.stroke();
        tx += s + 8;
      }
      drawText(ctx, it.f, it.text, it.color, tx, y);
    } else if (it.kind === "curves") {
      let cx = x + indent;
      const cw = intOf(70 * u);
      const ch = intOf(22 * u);
      for (const pts of it.curves) {
        const fx = cx;
        const fy = y + intOf(2 * u);
        roundRect(ctx, fx, fy, cw, ch, 3);
        ctx.fillStyle = "rgb(22,22,28)";
        ctx.fill();
        if (pts.length >= 2 && pts.at(-1)[0] > 0) {
          const span = pts.at(-1)[0];
          ctx.beginPath();
          pts.forEach(([tt, hh], i) => {
            const level = Math.max(0, Math.min(1, Number.isNaN(hh) ? 1 : hh));
            const px = fx + 3 + (cw - 6) * tt / span;
            const py = fy + ch - 3 - (ch - 6) * level;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.strokeStyle = "rgb(150,160,190)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        cx += cw + intOf(8 * u);
      }
    }
    y += it.h;
  }
}

function blockFor(entry, width, u, measure) {
  const key = `${width}|${u}`;
  if (entry.blockKey !== key) {
    entry.block = entryItems(entry.ev, width, u, measure);
    entry.blockKey = key;
  }
  return entry.block;
}

/**
 * draw_panel. Newest at the bottom; `view.panelScroll` (px) looks further
 * back. Returns {total, maxScroll} so the page can clamp its scrolling.
 */
export function drawPanel(ctx, lay, view, measure) {
  const rect = lay.panel;
  if (rect === null) return null;
  const u = lay.u;
  ctx.fillStyle = css(PANEL_BG);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "rgb(30,30,37)";
  if (lay.panelSide === "bottom") ctx.fillRect(rect.x, rect.y, rect.w, 1);
  else ctx.fillRect(rect.x, rect.y, 1, rect.h);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const pad = intOf(22 * u);
  const x = rect.x + pad;
  const width = rect.w - 2 * pad;
  let y = rect.y + intOf(20 * u);
  const head = font("sans", 13 * u);
  drawText(ctx, head, "OBSERVER", TEXT_DIM, x, y);
  y += head.lineH + intOf(2 * u);
  const hides = view.touch ? "The Observer button hides it." : "Tab hides it.";
  for (const line of wrap(measure, head, "The mind's private side: what it thinks and what it does. "
    + `The person in the room never sees this. ${hides}`, width)) {
    drawText(ctx, head, line, TEXT_FAINT, x, y);
    y += head.lineH;
  }
  y += intOf(10 * u);
  ctx.fillStyle = "rgb(30,30,37)";
  ctx.fillRect(x, y, rect.x + rect.w - pad - x, 1);
  let top = y + intOf(6 * u);

  const obs = view.observer;
  const entries = obs.entries;
  const bottom = rect.y + rect.h - intOf(16 * u);
  if (!entries.length) {
    const msg = { none: "No mind is connected, so there is nothing to observe.",
      waiting: "Nothing yet. The mind wakes when someone arrives." }[obs.status] ?? "Nothing yet.";
    const f = font("sans", 15 * u, true);
    for (const line of wrap(measure, f, msg, width)) {
      drawText(ctx, f, line, TEXT_FAINT, x, top + intOf(8 * u));
      top += f.lineH;
    }
    return { total: 0, maxScroll: 0 };
  }

  const blocks = entries.map((e) => blockFor(e, width, u, measure));
  const total = blocks.reduce((sum, b) => sum + b.height, 0);
  const maxScroll = Math.max(0, total - (bottom - top));
  const scroll = Math.max(0, Math.min(view.panelScroll || 0, maxScroll));

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, top, rect.w, bottom - top);
  ctx.clip();
  let by = bottom + scroll;
  for (let i = blocks.length - 1; i >= 0; i--) {
    by -= blocks[i].height;
    if (by > bottom) continue;
    drawBlock(ctx, blocks[i].items, x, by, width, u);
    if (by < top) break;
  }
  ctx.restore();

  const fadeH = intOf(30 * u);
  if (by < top) fade(ctx, rect.x + 1, top, rect.w - 1, fadeH, true);
  if (scroll > 0) {
    fade(ctx, rect.x + 1, bottom - fadeH, rect.w - 1, fadeH, false);
    const f = font("sans", 12 * u);
    ctx.textAlign = "right";
    drawText(ctx, f, "newer below", TEXT_FAINT, rect.x + rect.w - pad, bottom);
    ctx.textAlign = "left";
  }
  return { total, maxScroll };
}

// Fade the oldest (or newest) lines into the panel's background.
function fade(ctx, x, y, w, h, downwards) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  const solid = css(PANEL_BG);
  const clear = css(PANEL_BG, 0);
  g.addColorStop(0, downwards ? solid : clear);
  g.addColorStop(1, downwards ? clear : solid);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}
