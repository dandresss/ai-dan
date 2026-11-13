// The room's chrome: the title overlay, the status line, the banners for odd
// states and the help. Ports draw_intro, draw_status, mind_status,
// draw_banners and draw_help from render.py. Text only: nothing here draws
// the body.

import {
  ASLEEP, AWAKE, BLACK, GHOST, GONE, PLATE_EDGE, TEXT, TEXT_DIM, TEXT_FAINT, VOICE, WARN,
  clock, css, dot, drawText, font, formatG, grouped, mix, roundRect, wrap,
} from "./render-base.js";

const intOf = (v) => Math.trunc(v);

/** Where the typing line sits (render.draw_typing). */
export function typingY(lay) {
  return lay.grid.bottom + intOf(lay.pitch * 0.9);
}

/** Top of the status line; it moves up when the page's buttons need the row. */
export function statusY(lay, view) {
  return lay.room.bottom - intOf(30 * lay.u) - (view.statusLift || 0);
}

function textCenter(ctx, measure, f, s, color, cx, y) {
  drawText(ctx, f, s, color, intOf(cx - measure(f, s) / 2), y);
  return f.lineH;
}

function box(ctx, x, y, w, h, { color = [8, 8, 11], alpha = 225, border = PLATE_EDGE } = {}) {
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = css(color, alpha / 255);
  ctx.fill();
  if (border) {
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8);
    ctx.strokeStyle = css(border);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** A calm box of text lines [font, text, colour], centred under `top`. */
function linesBox(ctx, measure, lay, lines, cx, top, { accent = null, maxW = null } = {}) {
  const u = lay.u;
  const pad = intOf(16 * u);
  maxW = maxW ?? intOf(Math.min(lay.room.w - 40, 640 * u));
  const rendered = [];
  for (const [f, s, color] of lines) {
    if (s === "") {
      rendered.push({ gap: intOf(f.lineH * 0.5) });
      continue;
    }
    for (const line of wrap(measure, f, s, maxW - 2 * pad)) rendered.push({ f, line, color });
  }
  const w = Math.max(0, ...rendered.filter((r) => r.f).map((r) => measure(r.f, r.line))) + 2 * pad;
  const h = rendered.reduce((sum, r) => sum + (r.f ? r.f.lineH + 2 : r.gap), 0) + 2 * pad;
  const x = cx - Math.floor(w / 2);
  box(ctx, x, top, w, h, { alpha: 232, border: accent ?? PLATE_EDGE });
  let y = top + pad;
  for (const r of rendered) {
    if (!r.f) {
      y += r.gap;
      continue;
    }
    drawText(ctx, r.f, r.line, r.color, x + pad, y);
    y += r.f.lineH + 2;
  }
  return { x, y: top, w, h, bottom: top + h };
}

const HOW_POINTER = [
  ["arrive", "Move the mouse into the room."],
  ["touch", "Hold the button down on the body."],
  ["speak", "Type, then press Enter."],
  ["go", "Leave the window."],
];
const HOW_TOUCH = [
  ["arrive", "Put a finger on the room."],
  ["touch", "Hold it on a pin."],
  ["speak", "Tap the line under the body."],
  ["go", "Lift your finger."],
];

function introLine(view) {
  if (view.mode === "dryrun") return "A scripted pattern drives this surface of 64 pins. It is a wiring test, not an AI.";
  if (view.mode === "nokey") return "No mind is connected to this surface of 64 pins.";
  return "An AI wakes up inside this surface of 64 pins. Nobody has told it what it is.";
}

export function drawIntro(ctx, lay, view, measure) {
  const a = Math.max(0, Math.min(1, view.intro));
  if (a <= 0.01) return;
  const u = lay.u;
  const room = lay.room;
  ctx.fillStyle = `rgba(2,2,4,${(200 * a) / 255})`;
  ctx.fillRect(room.x, room.y, room.w, room.h);
  ctx.save();
  ctx.globalAlpha = a;
  const cx = room.cx;
  const titleF = font("serif", 46 * u);
  const titleLines = wrap(measure, titleF, "A body to wake up in", room.w * 0.92);
  const subF = font("sans", 18 * u);
  const howF = font("sans", 16 * u);
  const keyF = font("sans", 13 * u);
  const how = view.touch ? HOW_TOUCH : HOW_POINTER;
  const blockH = titleLines.length * titleF.lineH + intOf(70 * u) + how.length * intOf(30 * u);
  let y = lay.grid.cy - blockH / 2 - intOf(10 * u);
  for (const line of titleLines) y += textCenter(ctx, measure, titleF, line, [232, 230, 236], cx, y);
  y += intOf(10 * u);
  for (const part of wrap(measure, subF, introLine(view), intOf(room.w * 0.8))) {
    y += textCenter(ctx, measure, subF, part, TEXT_DIM, cx, y);
  }
  y += intOf(26 * u);
  const col = intOf(84 * u);
  const x = cx - intOf(150 * u);
  for (const [key, what] of how) {
    const k = key.toUpperCase();
    drawText(ctx, keyF, k, TEXT_FAINT, x + col - measure(keyF, k) - intOf(14 * u), y + (howF.lineH - keyF.lineH) / 2 + 1);
    drawText(ctx, howF, what, TEXT, x + col, y);
    y += intOf(30 * u);
  }
  ctx.restore();
}

/** (word, colour, detail) for the status line: render.mind_status, plus a
 * turn that failed without retries (a wrong key fails that way). */
export function mindStatus(obs, t, view) {
  if (obs.status === "ended") return ["gone", GONE, "the session has ended"];
  if (view.mode === "nokey" || obs.status === "none") return ["no mind", GONE, "the body is here, but nothing will wake in it"];
  if (obs.status === "starting") return ["starting", TEXT_FAINT, ""];
  if (obs.status === "waiting") return ["not yet awake", ASLEEP, "it wakes when someone arrives"];
  if (obs.status === "awake") {
    const waited = Math.max(0.0, t - (obs.wakeT || 0.0));
    if (obs.errorsInARow) return ["awake", WARN, `the model did not answer, retrying (${obs.errorsInARow})`];
    if (obs.callsThisTurn === 0) {
      let note = "thinking";
      if (waited > 2) note += `  ${intOf(waited)} s`;
      if (obs.turn <= 1 && waited > 2) note += "  (a first thought takes a few seconds)";
      else if (waited > 40) note += "  (longer than usual)";
      return ["awake", AWAKE, note];
    }
    return ["awake", AWAKE, `${obs.callsThisTurn} call${obs.callsThisTurn !== 1 ? "s" : ""} this turn`];
  }
  if (obs.status === "asleep") {
    if (obs.lastTurnFailed) return ["asleep", WARN, "the model did not answer; it tries again at the next wake"];
    const pulse = obs.header?.config?.PULSE_S;
    const every = typeof pulse === "number" || typeof pulse === "boolean"
      ? `every ${formatG(Number(pulse))} s` : "every few seconds";
    return ["asleep", ASLEEP, `it wakes when you speak, arrive or leave, and ${every} while you are here`];
  }
  return [obs.status, TEXT_FAINT, ""];
}

/** Tokens spent so far, as the status line shows them; "" before any. */
export function tokenText(obs) {
  if (!obs.inputTokens && !obs.outputTokens) return "";
  return `${grouped(obs.inputTokens)} in / ${grouped(obs.outputTokens)} out tokens`;
}

export function drawStatus(ctx, lay, snap, view, measure) {
  const obs = view.observer;
  const u = lay.u;
  const f = font("sans", 14 * u);
  const t = snap ? snap.t : 0.0;
  const [status, color, detail] = mindStatus(obs, t, view);
  let x = intOf(22 * u);
  const y = statusY(lay, view);
  dot(ctx, x + 4, y + Math.floor(f.lineH / 2), Math.max(3, 3.5 * u), color);
  x += intOf(16 * u);
  const parts = [clock(t)];
  if (obs.turn) parts.push(`turn ${obs.turn}`);
  parts.push(status);
  const tokens = tokenText(obs);
  if (tokens) parts.push(tokens);
  const s = parts.join("   ·   ");
  drawText(ctx, f, s, TEXT_DIM, x, y);
  lay.statusRight = x + measure(f, s);
  const keysLeft = view.keysLeft ?? lay.room.right - intOf(22 * u);
  if (detail) {
    const d = `   ${detail}`;
    if (x + measure(f, s) + measure(f, d) < keysLeft - intOf(20 * u)) drawText(ctx, f, d, TEXT_FAINT, x + measure(f, s), y);
  }
}

/** The line the person said, fading above the typing line. */
export function drawSaid(ctx, lay, view, measure) {
  if (!view.said || view.saidAlpha <= 0.02) return;
  const f = font("sans", 18 * lay.u);
  ctx.save();
  ctx.globalAlpha = (200 * view.saidAlpha) / 255;
  textCenter(ctx, measure, f, `“${view.said}”`, VOICE, lay.room.cx, typingY(lay) - intOf(28 * lay.u));
  ctx.restore();
}

/** A dry run, or a replay of one: it must never pass for an AI. */
export function isWiringTest(view) {
  return view.mode === "dryrun" || view.observer.mind === "scripted";
}

/** The banner shows once the mind has failed: twice in a row, or once with
 * the turn given up (an answer that will not change on retry). */
export function mindFailing(obs) {
  return obs.status !== "ended" && (obs.errorsInARow >= 2 || (obs.errorsInARow >= 1 && obs.lastTurnFailed));
}

const WHY = {
  max_turns: "it used all of its turns",
  max_minutes: "the session reached its time limit",
  window_closed: "the session was ended",
};

/** Mode labels at the top of the room, and calm messages for odd states. */
export function drawBanners(ctx, lay, snap, view, measure) {
  const u = lay.u;
  const cx = lay.room.cx;
  let top = intOf(18 * u);
  const obs = view.observer;

  if (isWiringTest(view)) {
    const f = font("sans", 15 * u);
    const label = "WIRING TEST   ·   a scripted pattern, not an AI";
    const w = measure(f, label) + intOf(28 * u);
    const h = f.lineH + intOf(12 * u);
    const x = cx - Math.floor(w / 2);
    roundRect(ctx, x, top, w, h, h / 2);
    ctx.fillStyle = css(WARN);
    ctx.fill();
    drawText(ctx, f, label, [24, 16, 6], intOf(x + (w - measure(f, label)) / 2), top + intOf(12 * u) / 2);
    top += h + intOf(10 * u);
  }

  if (view.mode === "replay") {
    const f = font("sans", 14 * u);
    const state = view.paused ? "paused" : (view.speed !== 1 ? `x${formatG(view.speed)}` : "");
    const now = snap ? snap.t : 0.0;
    let words = ["REPLAY", view.replayName || "", `${clock(now)} / ${clock(view.replayTotal)}`];
    if (state) words.push(state);
    if (view.replayProgress >= 1) words.push("end of recording");
    let label = words.join("   ·   ");
    if (measure(f, label) + intOf(28 * u) > lay.room.w - 16) {   // a phone: drop the file name
      words = words.filter((wd, i) => i !== 1);
      label = words.join("   ·   ");
    }
    const w = measure(f, label) + intOf(28 * u);
    const h = f.lineH + intOf(16 * u);
    const x = cx - Math.floor(w / 2);
    box(ctx, x, top, w, h, { border: mix(BLACK, GHOST, 0.5) });
    drawText(ctx, f, label, [200, 212, 236], x + intOf(14 * u), top + intOf(6 * u));
    const barX = x + intOf(14 * u);
    const barW = w - intOf(28 * u);
    const barY = top + h - intOf(5 * u);
    ctx.fillStyle = "rgb(36,40,52)";
    ctx.fillRect(barX, barY, barW, 2);
    ctx.fillStyle = css(GHOST);
    ctx.fillRect(barX, barY, intOf(barW * Math.max(0, Math.min(1, view.replayProgress))), 2);
    top += h + intOf(10 * u);
    const hint = view.touch ? "the ring is the recorded visitor" : "Space pauses   ·   the ring is the recorded visitor";
    textCenter(ctx, measure, font("sans", 12 * u), hint, TEXT_FAINT, cx, top);
  }

  if (view.mode === "nokey") {
    const lines = [
      [font("sans", 15 * u), "No mind is connected. The body is here, but nothing will wake in it: "
        + (view.nokeyDetail || "no key was given."), TEXT],
      [font("sans", 13 * u), "Go back to the start to try again, or to watch the first waking.", TEXT_DIM],
    ];
    top = linesBox(ctx, measure, lay, lines, cx, top, { accent: [52, 52, 60],
      maxW: intOf(Math.min(lay.room.w - 40, 760 * u)) }).bottom + intOf(10 * u);
  }

  if (mindFailing(obs)) {
    const n = obs.errorsInARow;
    const lines = [
      [font("sans", 14 * u), `The mind cannot be reached right now (${n} failed attempt${n !== 1 ? "s" : ""}). `
        + "The body is fine and keeps going.", WARN],
      [font("mono", 13 * u), (obs.lastError || "").slice(0, 300), TEXT_DIM],
    ];
    if (/HTTP 40[13]\b|x-api-key|authentication|access code/i.test(obs.lastError || "")) {
      lines.push([font("sans", 13 * u), "The key or access code was not accepted. End the session and check it.", TEXT]);
    }
    linesBox(ctx, measure, lay, lines, cx, top, { accent: mix(BLACK, WARN, 0.6) });
  }

  const below = lay.grid.bottom + intOf(lay.pitch * 0.55);
  const wide = intOf(Math.min(lay.room.w - 40, 760 * u));
  if (obs.status === "ended" && view.mode !== "replay") {
    const f = font("sans", 15 * u);
    const mono = font("mono", 13 * u);
    const reason = obs.close?.reason ?? "";
    const why = WHY[reason] ?? String(reason);
    const lines = [[f, "The mind has gone quiet" + (why ? `: ${why}.` : ".") + " The body stays as it was left.", TEXT]];
    if (view.logName) {
      lines.push(
        [mono, `log      ${view.logName}   (Download log keeps it)`, TEXT_DIM],
        [mono, `analyse  uv run python -m lab.analyze ${view.logName}`, TEXT_DIM],
        [mono, `replay   uv run python main.py --replay ${view.logName}`, TEXT_DIM],
      );
    }
    linesBox(ctx, measure, lay, lines, cx, below, { maxW: wide });
  }

  if (view.mode === "replay" && view.replayCheck) {
    const { mismatches, states, calls } = view.replayCheck;
    const f = font("sans", 14 * u);
    let lines;
    if (mismatches.length) {
      lines = [
        [f, `The replay differed from the log in ${mismatches.length} place${mismatches.length !== 1 ? "s" : ""}, `
          + `first at ${mismatches[0]}.`, WARN],
        [font("mono", 13 * u), `uv run python main.py --verify ${view.replayName || "FILE"}   gives the details`, TEXT_DIM],
      ];
    } else if (states || calls) {
      lines = [[f, `Replayed from the log: the body reached the same state at all ${states} checks, `
        + `and ${calls} call${calls !== 1 ? "s" : ""} got the same answers.`, TEXT_DIM]];
    } else {
      lines = [[f, "Replayed from the log. It had no body states to compare.", TEXT_DIM]];
    }
    linesBox(ctx, measure, lay, lines, cx, below, { maxW: wide,
      accent: mismatches.length ? mix(BLACK, WARN, 0.6) : mix(BLACK, GHOST, 0.5) });
  }
}

function helpRows(view) {
  if (view.touch) {
    return [
      ["finger", "a finger down puts you in the room; on a pin it presses it"],
      ["lift", "lifting it is leaving"],
      view.mode === "replay" ? ["Pause", "pause or resume the replay"] : ["speak", "tap the line under the body, type, then send"],
      ["Observer", "the mind's private side"],
    ];
  }
  const rows = [
    ["mouse", "move in the room; hold the button on a pin to press it"],
    ["typing", "your voice; Enter says the line"],
    ["Tab", "observer panel: the mind's private side"],
    ["Shift+Tab", "to the buttons below; Tab moves between them"],
    ["F1", "this help"],
    ["F2", "hide all text, for clean recordings"],
    ["F11", "fullscreen"],
    ["Esc", "close this help"],
  ];
  if (view.mode === "replay") rows[1] = ["Space", "pause or resume the replay"];
  return rows;
}

export function drawHelp(ctx, lay, view, measure) {
  const u = lay.u;
  const f = font("sans", 15 * u);
  const dim = font("sans", 14 * u);
  const rows = helpRows(view);
  const pad = intOf(20 * u);
  const gap = intOf(18 * u);
  const keyW = Math.max(...rows.map(([k]) => measure(dim, k)));
  const footText = view.touch || view.mode === "replay"
    ? "Nothing on screen moves unless the body's state says so."
    : "Letters are never shortcuts: typing is how you speak to it.";
  const maxW = lay.room.w - 24;
  const valMax = Math.min(Math.max(...rows.map(([, v]) => measure(dim, v))), maxW - 2 * pad - keyW - gap);
  const values = rows.map(([, v]) => wrap(measure, dim, v, valMax));
  const foot = wrap(measure, dim, footText, maxW - 2 * pad);
  const line = dim.lineH + intOf(4 * u);
  const valW = Math.max(...values.flat().map((v) => measure(dim, v)));
  const footW = Math.max(...foot.map((v) => measure(dim, v)));
  const w = Math.max(keyW + gap + valW, footW) + 2 * pad;
  const lineCount = values.reduce((sum, v) => sum + v.length, 0);
  const h = 2 * pad + f.lineH + intOf(10 * u) + lineCount * line + intOf(12 * u) + foot.length * dim.lineH;
  const x0 = lay.room.cx - Math.floor(w / 2);
  const y0 = lay.grid.cy - Math.floor(h / 2);
  box(ctx, x0, y0, w, h, { alpha: 242 });
  const x = x0 + pad;
  let y = y0 + pad;
  drawText(ctx, f, view.touch ? "How" : "Keys", TEXT, x, y);
  y += f.lineH + intOf(10 * u);
  rows.forEach(([k], i) => {
    drawText(ctx, dim, k, TEXT, x, y);
    for (const v of values[i]) {
      drawText(ctx, dim, v, TEXT_DIM, x + keyW + gap, y);
      y += line;
    }
  });
  y += intOf(12 * u);
  for (const part of foot) {
    drawText(ctx, dim, part, TEXT_FAINT, x, y);
    y += dim.lineH;
  }
}
