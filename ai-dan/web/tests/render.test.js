// Tests for the page's pure logic: render.js (layout, clock, the observer's
// reading of the feed, call summaries, the status line), the fixed-step loop,
// the pointer, and the session lifecycle. Expected values for the ports come
// from the Python lab: tests/fixtures/render_fixtures.py writes render.json.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fixed, font, formatG, grouped, pyJson, splitLines, wrap } from "../lab/render-base.js";
import {
  Observer, callLine, clock, draw, drawBody, entryItems, isWiringTest, layout, makeView, mindFailing, mindStatus,
  pinFace, restingSnapshot, statusY, tokenText, typingY,
} from "../lab/render.js";
import { FixedStep, MAX_CATCH_UP, Pointer, STEP_S } from "../lab/ui-loop.js";
import { MAX_LINE, Session, cleanLine } from "../lab/ui-session.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/render.json", import.meta.url), "utf8"));
const firstWake = readFileSync(new URL("../sessions/first-wake.jsonl", import.meta.url), "utf8")
  .split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

// Every character 7 px wide, like the fixture's FakeFont.
const measure7 = (f, s) => 7 * [...s].length;

// --- Python formatting -----------------------------------------------------
test("clock prints whole seconds as m:ss, like render.clock", () => {
  for (const [t, expected] of fixtures.clock) assert.equal(clock(t), expected, `clock(${t})`);
});

test("formatG matches Python's :g", () => {
  for (const [x, expected] of fixtures.format.g) {
    const value = Object.is(x, 0) && expected === "-0" ? -0 : x;
    assert.equal(formatG(value), expected, `${x}`);
  }
});

test("fixed matches Python's :.2f, ties to even included", () => {
  for (const [x, expected] of fixtures.format.fixed2) {
    const value = expected.startsWith("-0") && x === 0 ? -0 : x;
    assert.equal(fixed(value, 2), expected, `${x}`);
  }
});

test("wrap breaks lines as render.wrap does", () => {
  for (const { text, width, lines } of fixtures.wrap) {
    assert.deepEqual(wrap(measure7, font("sans", 14), text, width), lines, `${JSON.stringify(text)} at ${width}`);
  }
});

test("splitLines follows str.splitlines", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("a\r\nb\rc"), ["a", "b", "c"]);
});

test("pyJson writes json.dumps with ensure_ascii", () => {
  assert.equal(pyJson({ a: "é", b: [1, 2], c: null, d: true }), '{"a": "\\u00e9", "b": [1, 2], "c": null, "d": true}');
});

test("grouped writes token counts as the README does", () => {
  assert.equal(grouped(21637), "21,637");
  assert.equal(grouped(896), "896");
  assert.equal(grouped(1234567), "1,234,567");
});

// --- layout ------------------------------------------------------------------
const box = (r) => (r === null ? null : [r.x, r.y, r.w, r.h]);

test("layout is the desktop's, to the pixel, on wide windows", () => {
  for (const c of fixtures.layout) {
    const lay = layout({ width: c.size[0], height: c.size[1] }, c.panel);
    const where = `${c.size.join("x")} panel=${c.panel}`;
    assert.deepEqual(box(lay.room), c.room, `room ${where}`);
    assert.deepEqual(box(lay.grid), c.grid, `grid ${where}`);
    assert.deepEqual(box(lay.panel), c.panelRect, `panel ${where}`);
    assert.ok(Math.abs(lay.pitch - c.pitch) < 1e-9, `pitch ${where}`);
    assert.ok(Math.abs(lay.u - c.u) < 1e-12, `u ${where}`);
    assert.equal(lay.compact, false);
  }
});

test("on a phone the grid fits the width and the panel goes below the room", () => {
  for (const [w, h] of [[390, 844], [360, 640], [320, 568]]) {
    for (const panel of [false, true]) {
      const lay = layout({ width: w, height: h }, panel);
      assert.equal(lay.compact, true);
      assert.ok(lay.grid.x >= 0 && lay.grid.right <= w, `grid inside ${w}x${h}`);
      assert.ok(lay.grid.bottom < lay.room.bottom, "grid inside the room");
      assert.ok(typingY(lay) < statusY(lay, makeView()), "typing line above the status line");
      if (panel) {
        assert.equal(lay.panelSide, "bottom");
        assert.deepEqual([lay.panel.x, lay.panel.w, lay.panel.bottom], [0, w, h]);
        assert.equal(lay.room.bottom, lay.panel.y);
      } else {
        assert.equal(lay.panel, null);
        assert.ok(lay.grid.w > (w / 13.5) * 8, "a bigger grid than the desktop margin would give");
      }
    }
  }
});

test("pixels and pin units map both ways, and pinAt finds the pin under a point", () => {
  const lay = layout({ width: 1280, height: 800 }, false);
  const px = lay.toPixels([2.5, 3.25]);
  const back = lay.toPinUnits(px);
  assert.ok(Math.abs(back[0] - 2.5) < 1e-9 && Math.abs(back[1] - 3.25) < 1e-9);
  assert.deepEqual(lay.pinAt(lay.toPixels([0.01, 7.99])), [0, 7]);
  assert.deepEqual(lay.pinAt(lay.toPixels([4.5, 4.5])), [4, 4]);
  assert.equal(lay.pinAt(lay.toPixels([8.2, 4])), null);
  assert.equal(lay.pinAt(lay.toPixels([-0.1, 4])), null);
  const margin = lay.toPinUnits([lay.grid.x - lay.pitch, lay.grid.y]);
  assert.deepEqual(margin.map((v) => Math.round(v * 1e9) / 1e9), [0, -1]);
});

// --- the honesty rule ----------------------------------------------------------
test("a pin's face depends on its height and the colour only, and brightens with height", () => {
  const tint = [80, 180, 255];
  let last = -1;
  for (let i = 0; i <= 10; i++) {
    const face = pinFace(i / 10, tint);
    const brightness = face[0] + face[1] + face[2];
    assert.ok(brightness >= last, "never darker as it rises");
    last = brightness;
  }
  assert.deepEqual(pinFace(0, tint), pinFace(0, tint));
  assert.notDeepEqual(pinFace(0, tint), [0, 0, 0], "dark but present at 0");
});

test("a resting body is all zeros, white", () => {
  const snap = restingSnapshot();
  assert.equal(snap.actual.flat().every((v) => v === 0), true);
  assert.deepEqual(snap.color, [255, 255, 255]);
  assert.equal(snap.person, null);
});

// --- the observer ------------------------------------------------------------------
function observe(events) {
  const obs = new Observer();
  for (const ev of events) obs.add(ev);
  return obs;
}

test("call lines match render._call_line for every logged call and odd inputs", () => {
  assert.ok(fixtures.calls.length > 40);
  for (const c of fixtures.calls) {
    const { line, curves, swatch } = callLine(c.ev);
    assert.equal(line, c.line, JSON.stringify(c.ev).slice(0, 200));
    assert.deepEqual(curves, c.curves, `curves of ${c.line}`);
    assert.deepEqual(swatch, c.swatch, `swatch of ${c.line}`);
  }
});

test("mindStatus matches render.mind_status", () => {
  for (const c of fixtures.status) {
    const obs = observe(c.events);
    assert.deepEqual(mindStatus(obs, c.t, makeView({ mode: c.mode, observer: obs })), c.status, c.name);
  }
});

test("the observer reads the first waking as render.Observer does, and counts its tokens", () => {
  const obs = observe(firstWake);
  const want = fixtures.observer;
  assert.equal(obs.status, want.status);
  assert.equal(obs.turn, want.turn);
  assert.equal(obs.wakeT, want.wake_t);
  assert.equal(obs.callsThisTurn, want.calls_this_turn);
  assert.equal(obs.errorsInARow, want.errors_in_a_row);
  assert.equal(obs.arrived, want.arrived);
  assert.equal(obs.mind, want.mind);
  assert.deepEqual(obs.entries.map((e) => e.ev.type), want.entries);
  assert.equal(obs.inputTokens, 21637);
  assert.equal(obs.outputTokens, 896);
  assert.equal(tokenText(obs), "21,637 in / 896 out tokens");
  assert.equal(tokenText(new Observer()), "");
});

test("the observer reads a feed incrementally", () => {
  const events = firstWake.slice(0, 40);
  const feed = { since: (i) => events.slice(i) };
  const obs = new Observer();
  obs.read(feed);
  const n = obs.entries.length;
  obs.read(feed);
  assert.equal(obs.entries.length, n, "nothing is read twice");
  assert.equal(obs.index, 40);
});

const HEADER = { type: "header", t: 0.0, mind: "live", model: "claude-sonnet-5-5", config: { PULSE_S: 12.0 } };
const WAKE = { type: "wake", t: 0.02, turn: 1, reasons: ["arrival"], message: '{"t": 0.02}' };

test("a turn given up after one error says plainly that the mind cannot be reached", () => {
  const error = { type: "api_error", t: 0.5, turn: 1, attempt: 1, error: "HTTP 401: invalid x-api-key" };
  const skipped = { type: "turn_end", t: 0.5, turn: 1, tool_calls: 0, capped: false, skipped: true };
  const obs = observe([HEADER, WAKE, error]);
  assert.equal(mindFailing(obs), false, "one retryable failure is not yet a banner");
  obs.add(skipped);
  assert.equal(mindFailing(obs), true);
  const [word, color, detail] = mindStatus(obs, 1.0, makeView({ observer: obs }));
  assert.equal(word, "asleep");
  assert.deepEqual(color, [236, 170, 84]);
  assert.match(detail, /did not answer/);
  obs.add({ ...WAKE, turn: 2, t: 12.5 });
  obs.add({ type: "usage", t: 13, turn: 2, model: "m", stop_reason: "end_turn", input_tokens: 5, output_tokens: 1 });
  assert.equal(mindFailing(obs), false, "an answer clears it");
});

test("two failed attempts in a row show the banner, as on the desktop", () => {
  const err = (attempt) => ({ type: "api_error", t: attempt, turn: 1, attempt, error: "ConnectionError: Failed to fetch" });
  assert.equal(mindFailing(observe([HEADER, WAKE, err(1), err(2)])), true);
  const ended = observe([HEADER, WAKE, err(1), err(2), { type: "close", t: 9, reason: "window_closed", turns: 1 }]);
  assert.equal(mindFailing(ended), false);
});

test("a wiring test is labelled whether it runs or is replayed", () => {
  assert.equal(isWiringTest(makeView({ mode: "dryrun" })), true);
  assert.equal(isWiringTest(makeView({ mode: "replay", observer: observe([{ ...HEADER, mind: "scripted" }]) })), true);
  assert.equal(isWiringTest(makeView({ mode: "replay", observer: observe([HEADER]) })), false);
});

test("panel entries carry the desktop's words", () => {
  const texts = (ev) => entryItems(ev, 1000, 1, measure7).items.filter((i) => i.text !== undefined).map((i) => i.text);
  assert.deepEqual(texts({ ...WAKE, t: 65.3, turn: 3, reasons: ["voice", "pulse"], message: '{"t": 65.3, "heard": ["hi", "you?"]}' }),
    ["TURN 3   ·   woke at 1:05   ·   voice, pulse", "heard: “hi”  /  “you?”"]);
  const thinking = entryItems({ type: "thought", t: 1, turn: 1, kind: "thinking", text: "  A time.  " }, 400, 1, measure7);
  assert.equal(thinking.items.at(-1).text, "A time.");
  assert.equal(thinking.items.at(-1).f.italic, true);
  const refused = { type: "call", t: 1, turn: 1, tick: 50, name: "play", args: { tracks: [] },
    result: { ok: false, t: 1, error: "That movement cannot be understood." } };
  assert.deepEqual(texts(refused), ["play  0 tracks: ", "refused: That movement cannot be understood."]);
  const played = entryItems(firstWake.find((e) => e.type === "call" && e.name === "play"), 400, 1, measure7);
  assert.ok(played.items.some((i) => i.kind === "curves"), "keyframe curves under a play");
  assert.deepEqual(texts({ type: "voice", t: 4, tick: 200, text: "hello" }), ["the person says “hello”"]);
  assert.deepEqual(texts({ type: "turn_end", t: 5, turn: 1, tool_calls: 1, capped: true, skipped: false }),
    ["asleep after 1 call, stopped at the cap"]);
  assert.deepEqual(texts({ type: "close", t: 34.3, reason: "window_closed", turns: 3, input_tokens: 21637, output_tokens: 896 }),
    ["SESSION ENDED   ·   window_closed   ·   3 turns, 21637 in / 896 out tokens"]);
  const colour = entryItems({ type: "call", t: 3.52, turn: 1, tick: 176, name: "set_color", args: { rgb: [80, 180, 255] },
    result: { ok: true, t: 3.52 } }, 400, 1, measure7);
  assert.deepEqual(colour.items.find((i) => i.kind === "indent").swatch, [80, 180, 255]);
  assert.equal(colour.height, colour.items.reduce((s, i) => s + i.h, 0));
});

// --- the loop --------------------------------------------------------------------
test("the fixed step keeps 50 ticks a second at 60 frames a second", () => {
  const clockStep = new FixedStep();
  let ticks = 0;
  for (let frame = 0; frame <= 60; frame++) clockStep.frame(frame / 60, () => { ticks += 1; });
  assert.ok(Math.abs(ticks - 50) <= 1, `${ticks} ticks`);
});

test("a stall runs at most MAX_CATCH_UP ticks and drops the rest", () => {
  const clockStep = new FixedStep();
  clockStep.frame(0, () => {});
  let ticks = 0;
  clockStep.frame(2.0, () => { ticks += 1; });
  assert.equal(ticks, MAX_CATCH_UP);
  assert.ok(clockStep.backlog <= STEP_S);
  ticks = 0;
  clockStep.frame(2.0 + 1 / 60, () => { ticks += 1; });
  assert.ok(ticks <= 2, "the dropped time is not replayed later");
});

test("pause, speed and the end of a replay", () => {
  const clockStep = new FixedStep();
  clockStep.frame(0, () => {});
  let ticks = 0;
  clockStep.frame(1, () => { ticks += 1; }, { paused: true });
  assert.equal(ticks, 0);
  clockStep.frame(1.1, () => { ticks += 1; }, { speed: 2 });
  assert.equal(ticks, 10, "0.1 s at double speed");
  clockStep.frame(3.1, () => { ticks += 1; }, { speed: 2 });
  assert.equal(ticks, 10 + 2 * MAX_CATCH_UP, "the cap grows with the speed");
  let calls = 0;
  clockStep.frame(3.2, () => { calls += 1; return false; });
  assert.equal(calls, 1);
  assert.equal(clockStep.backlog, 0, "a finished replay keeps no backlog");
});

// --- the pointer -----------------------------------------------------------------
const LAY = layout({ width: 1280, height: 800 }, false);
const pinPx = (r, c) => LAY.toPixels([r + 0.5, c + 0.5]);

test("a mouse: in the window is presence, the held button on a pin is touch", () => {
  const p = new Pointer();
  assert.equal(p.person(LAY), null);
  p.move(...pinPx(9, 4), "mouse");
  assert.equal(p.arrived, true);
  assert.ok(p.person(LAY)[0] > 9);
  assert.equal(p.pressed(LAY), null, "moving is not touching");
  p.down(...pinPx(3, 5), "mouse");
  assert.deepEqual(p.pressed(LAY), [3, 5]);
  p.move(...pinPx(3, 6), "mouse");
  assert.deepEqual(p.pressed(LAY), [3, 6], "dragging presses the pin under the pointer");
  p.up("mouse");
  assert.equal(p.pressed(LAY), null);
  assert.ok(p.person(LAY), "still in the room");
  p.leave();
  assert.equal(p.person(LAY), null);
});

test("a finger: down is presence and touch, lifting it is leaving", () => {
  const p = new Pointer();
  p.move(...pinPx(2, 2), "touch");
  assert.equal(p.person(LAY), null, "no hovering finger");
  p.down(...pinPx(2, 2), "touch");
  assert.equal(p.touch, true);
  assert.deepEqual(p.pressed(LAY), [2, 2]);
  p.move(...LAY.toPixels([9.5, 4]), "touch");
  assert.equal(p.pressed(LAY), null, "a finger on the margin is presence without touch");
  assert.ok(p.person(LAY));
  p.up("touch");
  assert.equal(p.person(LAY), null);
  assert.equal(p.pressed(LAY), null);
});

// --- the session -------------------------------------------------------------------
test("cleanLine keeps printable characters, as the desktop's typing does", () => {
  assert.equal(cleanLine("  hello\tthere\u0007 "), "hellothere");
  assert.equal(cleanLine("café  ok"), "café ok");
  assert.equal([...cleanLine("x".repeat(500))].length, MAX_LINE);
});

function fakeLive(order = []) {
  const feedEvents = [];
  const world = {
    config: { GRID_ROWS: 8, GRID_COLS: 8, TICK_HZ: 50 },
    feed: { since: (i) => feedEvents.slice(i) },
    ticks: [],
    said: [],
    tick(person, pressed) { this.ticks.push([person, pressed]); },
    say(text) { this.said.push(text); },
    close() { order.push("world.close"); },
  };
  const harness = { async stop(reason) { order.push(`harness.stop:${reason}`); } };
  const log = { close() { order.push("log.close"); } };
  return { world, harness, log, feedEvents };
}

test("a live session ticks with the person and the pin under the pointer", () => {
  const { world, harness, log } = fakeLive();
  const s = new Session({ kind: "live", world, harness, log, view: makeView() });
  s.layout = LAY;
  s.advance(0);
  s.advance(0.101);
  assert.equal(world.ticks.length, 5);
  assert.deepEqual(world.ticks[0], [null, null], "nobody yet");
  s.pointer.down(...pinPx(1, 1), "mouse");
  s.advance(0.15);
  const [person, pressed] = world.ticks.at(-1);
  assert.ok(Math.abs(person[0] - 1.5) < 1e-9 && Math.abs(person[1] - 1.5) < 1e-9);
  assert.deepEqual(pressed, [1, 1]);
  assert.deepEqual(s.view.cursor, pinPx(1, 1));
  assert.equal(s.view.pressing, true);
});

test("speaking: one clean line reaches the world and shows as said", () => {
  const { world, harness, log } = fakeLive();
  const s = new Session({ kind: "live", world, harness, log, view: makeView() });
  assert.equal(s.say("   "), "");
  assert.equal(s.say(" hello? "), "hello?");
  assert.deepEqual(world.said, ["hello?"]);
  assert.equal(s.view.said, "hello?");
  assert.equal(s.view.saidAlpha, 1);
});

test("shutting down closes the world, then the mind, then the log, once", async () => {
  const order = [];
  const { world, harness, log } = fakeLive(order);
  const s = new Session({ kind: "live", world, harness, log, view: makeView() });
  assert.equal(s.running, true);
  await s.shutdown();
  await s.shutdown();
  assert.deepEqual(order, ["world.close", "harness.stop:window_closed", "log.close"]);
  assert.equal(s.running, false);
  const before = world.ticks.length;
  s.advance(5);
  s.advance(6);
  assert.equal(world.ticks.length, before, "no ticks after the end");
  assert.equal(s.view.cursor, null, "the person has left the room");
});

test("the first waking replays to its end with the same body states", async () => {
  const { ReplayWorld } = await import("../lab/world.js");
  const world = new ReplayWorld(firstWake);
  const view = makeView({ mode: "replay", intro: 0, replayName: "first-wake.jsonl" });
  const s = new Session({ kind: "replay", world, view, events: firstWake, name: "first-wake.jsonl" });
  let now = 0;
  s.advance(now);
  while (!world.done && now < 120) {
    now += 0.2;
    s.advance(now);
  }
  assert.equal(world.done, true);
  assert.equal(view.replayProgress, 1);
  assert.ok(Math.abs(view.replayTotal - 34.3) < 0.05, `${view.replayTotal} s`);
  assert.deepEqual(view.replayCheck.mismatches, []);
  assert.ok(view.replayCheck.states > 0 && view.replayCheck.calls > 0);
  assert.equal(view.observer.status, "ended");
  assert.equal(view.observer.inputTokens, 21637);
});

// --- the page's files ----------------------------------------------------------------
test("index.html loads one module script and nothing from outside", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="module" src="lab/app.js">']);
  assert.doesNotMatch(html, /<script\b[^>]*>[^<\s]/, "no inline script");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline handlers");
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  for (const text of [html, css]) assert.doesNotMatch(text, /(src|href)=["']?https?:|@import|url\(\s*["']?https?:/i);
});

test("every element the scripts look up exists in index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const file of ["app.js", "ui-start.js"]) {
    const js = readFileSync(new URL(`../lab/${file}`, import.meta.url), "utf8");
    for (const m of js.matchAll(/\$\("([^"]+)"\)|getElementById\("([^"]+)"\)/g)) {
      const id = m[1] ?? m[2];
      assert.ok(ids.has(id), `${file} looks up #${id}`);
    }
  }
  const acts = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
  const app = readFileSync(new URL("../lab/app.js", import.meta.url), "utf8");
  for (const act of acts) assert.match(app, new RegExp(`case "${act}"`), `action ${act} is handled`);
});

// --- drawing, on a strict fake canvas ----------------------------------------------
// Only real CanvasRenderingContext2D members exist on it, and every number
// passed must be finite, so a typo or a NaN in render.js fails here.
const CTX_METHODS = new Set(["fillRect", "beginPath", "moveTo", "lineTo", "arc", "arcTo", "closePath", "fill",
  "stroke", "fillText", "save", "restore", "setTransform", "translate", "putImageData", "drawImage", "rect", "clip"]);
const CTX_PROPS = new Set(["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline", "textAlign", "globalAlpha",
  "globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality"]);

function fakeCanvas() {
  const ops = [];
  const state = {};
  const finite = (name, args) => {
    for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
  };
  const gradient = (args) => ({
    args,
    stops: [],
    addColorStop(offset, color) {
      if (!(offset >= 0 && offset <= 1) || typeof color !== "string") throw new Error(`bad colour stop ${offset} ${color}`);
      this.stops.push([offset, color]);
    },
  });
  const impl = {
    measureText: (s) => ({ width: 7 * [...s].length }),
    createRadialGradient: (...a) => gradient(a),
    createLinearGradient: (...a) => gradient(a),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy({}, {
    get(_, name) {
      if (name === "ops") return ops;
      if (Object.hasOwn(impl, name)) return (...args) => { finite(name, args); ops.push([name, ...args]); return impl[name](...args); };
      if (CTX_METHODS.has(name)) return (...args) => { finite(name, args); ops.push([name, ...args]); };
      if (CTX_PROPS.has(name)) return state[name];
      if (name === "then") return undefined;
      throw new Error(`a 2D context has no ${String(name)}`);
    },
    set(_, name, value) {
      if (!CTX_PROPS.has(name)) throw new Error(`a 2D context has no property ${String(name)}`);
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} = ${value}`);
      if (name === "globalCompositeOperation" && !["source-over", "lighter"].includes(value)) throw new Error(value);
      ops.push(["set", name, typeof value === "object" ? "gradient" : value]);
      state[name] = value;
      return true;
    },
  });
}
globalThis.OffscreenCanvas ??= class {
  getContext() { return fakeCanvas(); }
};

function swell(phase) {
  return Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => {
    const d = Math.hypot(r - 3.5, c - 3.5) / 5;
    return Math.round(Math.max(0, Math.min(1, 0.5 + 0.45 * Math.sin(phase - d * 2.2))) * 1000) / 1000;
  }));
}
function snapOf({ actual = swell(1.4), color = [120, 170, 255], person = null, pressed = null, t = 21 } = {}) {
  return { ...restingSnapshot(), tick: Math.round(t * 50), t, actual, target: actual, color, person, pressed };
}
const STORY = fixtures.status.find((c) => c.name === "ended").events;

test("every scene draws without an error, on a desktop and on a phone", () => {
  const near = LAY.toPixels([9.4, 5.2]);
  const err = (attempt) => ({ type: "api_error", t: 8 + attempt, turn: 1, attempt, error: "HTTP 529: Overloaded" });
  const scenes = {
    start: [restingSnapshot(), makeView({ mode: "replay", clean: true, intro: 0 })],
    intro: [snapOf({ actual: restingSnapshot().actual }), makeView({ observer: observe([HEADER]) })],
    introTouch: [snapOf(), makeView({ observer: observe([HEADER]), touch: true, intro: 0.5 })],
    dormant: [snapOf({ person: [9.4, 5.2] }), makeView({ observer: observe(STORY.slice(0, 3)), intro: 0, cursor: near })],
    touch: [snapOf({ pressed: [3, 5], person: [3.5, 5.5] }), makeView({ observer: observe(STORY.slice(0, 9)), intro: 0,
      cursor: LAY.toPixels([3.5, 5.5]), pressing: true, said: "can you feel this", saidAlpha: 0.7 })],
    panel: [snapOf(), makeView({ observer: observe(STORY), intro: 0, panel: true })],
    scrolled: [snapOf(), makeView({ observer: observe(STORY), intro: 0, panel: true, panelScroll: 120 })],
    ended: [snapOf(), makeView({ observer: observe(STORY), intro: 0, logName: "2026-11-12_101500.jsonl" })],
    nokey: [snapOf(), makeView({ mode: "nokey", observer: observe([{ ...HEADER, mind: "none" }]),
      nokeyDetail: "the mind's code could not be started (TypeError: x)." })],
    dryrun: [snapOf(), makeView({ mode: "dryrun", observer: observe([{ ...HEADER, mind: "scripted" }]), intro: 0, cursor: near })],
    replay: [snapOf({ person: [2.5, 2.5], pressed: [2, 2] }), makeView({ mode: "replay", observer: observe(STORY), intro: 0,
      replayName: "first-wake.jsonl", replayProgress: 0.31, replayTotal: 34.3, speed: 2, paused: true })],
    replayOk: [snapOf(), makeView({ mode: "replay", observer: observe(STORY), intro: 0, replayProgress: 1, replayTotal: 34.3,
      replayCheck: { mismatches: [], states: 7, calls: 6 } })],
    replayBad: [snapOf(), makeView({ mode: "replay", observer: observe(STORY), intro: 0, replayName: "x.jsonl",
      replayCheck: { mismatches: ["tick 250: body state differs from the log"], states: 7, calls: 6 } })],
    errors: [snapOf(), makeView({ observer: observe([...STORY.slice(0, 3), err(1), err(2), err(3)]), intro: 0, cursor: near })],
    badKey: [snapOf(), makeView({ observer: observe([HEADER, WAKE, { type: "api_error", t: 1, turn: 1, attempt: 1,
      error: "HTTP 401: invalid x-api-key" }, { type: "turn_end", t: 1, turn: 1, tool_calls: 0, capped: false, skipped: true }]), intro: 0 })],
    help: [snapOf(), makeView({ observer: observe(STORY.slice(0, 3)), intro: 0, help: true })],
    helpTouch: [snapOf(), makeView({ mode: "replay", observer: observe(STORY), intro: 0, help: true, touch: true })],
    clean: [snapOf(), makeView({ mode: "dryrun", observer: observe(STORY), intro: 0, clean: true, panel: true })],
  };
  for (const [width, height, dpr] of [[1280, 800, 1], [1920, 1080, 2], [390, 844, 3], [844, 390, 2], [200, 160, 1]]) {
    for (const [name, [snap, view]] of Object.entries(scenes)) {
      const ctx = fakeCanvas();
      const lay = draw(ctx, snap, view, { width, height, dpr });
      assert.ok(ctx.ops.length > 64, `${name} at ${width}x${height} drew something`);
      if (view.panel && !view.clean) assert.ok(lay.panelInfo, `${name}: the panel was drawn`);
      if (name === "dryrun" || name === "clean") {
        assert.ok(ctx.ops.some((op) => op[0] === "fillText" && /not an AI/.test(op[1])), `${name}: labelled not an AI`);
      }
    }
  }
});

test("the honesty rule: a pin is drawn from its height and the colour, and nothing else", () => {
  const lay = layout({ width: 1280, height: 800, dpr: 2 }, false);
  const actual = swell(0.7);
  const opsOf = (snap) => {
    const ctx = fakeCanvas();
    drawBody(ctx, snap, lay);
    return JSON.stringify(ctx.ops);
  };
  const base = opsOf(snapOf({ actual, t: 3 }));
  // Time, the person, a pressed pin, the orders and the trace change nothing.
  assert.equal(opsOf({ ...snapOf({ actual, t: 812.4, person: [4.5, 4.5], pressed: [4, 4] }),
    target: swell(2.5), gap_max: swell(1.1) }), base);
  // The real heights and the colour do.
  assert.notEqual(opsOf(snapOf({ actual: swell(1.9), t: 3 })), base);
  assert.notEqual(opsOf(snapOf({ actual, t: 3, color: [255, 196, 150] })), base);
});
