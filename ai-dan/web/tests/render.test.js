// Tests for the page's pure logic: render.js (layout, clock, the observer's
// reading of the feed, call summaries, the status line, the 3D view), the
// fixed-step loop, the pointer, and the session lifecycle. Expected values for
// the ports come from the Python lab: tests/fixtures/render_fixtures.py writes
// render.json, and make_camera_fixtures.py writes camera.json.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Camera } from "../lab/camera.js";
import {
  BLACK, PLATE, PLATE_EDGE, WHITE, css, fixed, font, formatG, grouped, mix, pyJson, splitLines, wrap,
} from "../lab/render-base.js";
import {
  Observer, callLine, clock, draw, drawBody, entryItems, isWiringTest, layout, makeView, mindFailing, mindStatus,
  pinFace, restingSnapshot, statusY, tokenText, typingY,
} from "../lab/render.js";
import { FixedStep, HIDDEN_CATCH_UP, MAX_CATCH_UP, Pointer, STEP_S, keyAction } from "../lab/ui-loop.js";
import { MAX_LINE, Session, cleanLine, notALog } from "../lab/ui-session.js";
import { hostMind, hostNote, takeValue } from "../lab/ui-start.js";
import { hostRefusal } from "../lab/render.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/render.json", import.meta.url), "utf8"));
const cameraCases = JSON.parse(readFileSync(new URL("./fixtures/camera.json", import.meta.url), "utf8")).cases;
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

test("a hidden tab keeps time with the wall clock, up to a minute per wake, with nobody in the room", () => {
  const { world, harness, log } = fakeLive();
  const s = new Session({ kind: "live", world, harness, log, view: makeView() });
  s.layout = LAY;
  s.pointer.down(...pinPx(4, 4), "mouse");     // even if the pointer still says someone is here
  s.advance(0);
  s.advance(30, { hidden: true });
  assert.ok(Math.abs(world.ticks.length - 1500) <= 1, `${world.ticks.length} ticks for 30 s`);
  assert.ok(world.ticks.every(([person, pressed]) => person === null && pressed === null), "nobody is in the room");
  const before = world.ticks.length;
  s.advance(150, { hidden: true });
  assert.equal(world.ticks.length - before, HIDDEN_CATCH_UP, "a two-minute gap runs one minute, the rest is dropped");
  assert.equal(HIDDEN_CATCH_UP * STEP_S, 60);
  assert.ok(s.stepper.backlog <= STEP_S);
  s.advance(150.05);
  assert.notEqual(world.ticks.at(-1)[0], null, "back in view, the pointer counts again");
});

test("downloads: the log counts as saved only while it has not grown since", () => {
  const lines = ['{"type": "header"}'];
  const log = { text: () => lines.map((l) => `${l}\n`).join(""), fileName: () => "2026-11-12_101500.jsonl" };
  const { world, harness } = fakeLive();
  const s = new Session({ kind: "live", world, harness, log, view: makeView() });
  assert.equal(s.unsaved, true, "nothing downloaded yet");
  const file = s.logFile();
  assert.equal(file.name, "2026-11-12_101500.jsonl");
  assert.equal(file.text, '{"type": "header"}\n');
  assert.equal(s.unsaved, false);
  lines.push('{"type": "state"}', '{"type": "close"}');
  assert.equal(s.unsaved, true, "a download taken mid-session is not the whole log");
  s.logFile();
  assert.equal(s.unsaved, false);
});

test("a mind that ended by itself is no longer running, though the room may go on", () => {
  const { world, harness, log } = fakeLive();
  const obs = observe([HEADER, WAKE]);
  const s = new Session({ kind: "live", world, harness, log, view: makeView({ observer: obs }) });
  assert.equal(s.running, true);
  assert.equal(s.mindEnded, false);
  obs.add({ type: "close", t: 900, reason: "max_minutes", turns: 12, input_tokens: 1, output_tokens: 1 });
  assert.equal(s.mindEnded, true);
  assert.equal(s.running, false);
  assert.equal(s.halted, false, "the world keeps ticking, as on the desktop");
  const dry = new Session({ kind: "dryrun", world, harness, log, view: makeView({ mode: "dryrun" }) });
  assert.equal(dry.running, false, "a wiring test is never a mind to lose");
});

test("what a key does in the room", () => {
  const live = (key, more = {}) => keyAction({ key, ...more });
  assert.equal(live("Tab"), "panel");
  assert.equal(live("Tab", { typing: true }), "panel", "Tab opens the observer from the typing line");
  assert.equal(live("Tab", { shift: true }), null, "Shift+Tab reaches the buttons");
  assert.equal(live("Tab", { onControl: true }), null, "a focused button keeps Tab");
  assert.equal(live("Tab", { ctrl: true }), null);
  assert.equal(live("F1", { onControl: true }), "help");
  assert.equal(live("F2"), "clean");
  assert.equal(live("Escape", { helpOpen: true }), "close-help");
  assert.equal(live("Escape"), null);
  assert.equal(live("a"), "type", "letters are never shortcuts");
  assert.equal(live("a", { onControl: true }), "type");
  assert.equal(live(" ", { onControl: true }), null, "Space presses a focused button");
  assert.equal(live("Enter", { onControl: true }), null);
  assert.equal(live("a", { typing: true }), null, "already typing");
  assert.equal(live("c", { ctrl: true }), null);
  assert.equal(live("Process"), "type", "an input method starting");
  assert.equal(live(" ", { replay: true }), "pause");
  assert.equal(live(" ", { replay: true, onControl: true }), null);
  assert.equal(live("a", { replay: true }), null, "a replay has no voice");
});

test("a damaged log is called what it is", async () => {
  assert.equal(notALog(new TypeError("Cannot read properties of null (reading 'type')")).message,
    "not a session log (Cannot read properties of null (reading 'type'))");
  assert.equal(notALog(new Error("not a session log: no header line")).message, "not a session log: no header line");
  const { ReplayWorld } = await import("../lab/world.js");
  for (const events of [[firstWake[0], null, ...firstWake.slice(1)], firstWake.slice(1)]) {
    let caught = null;
    try {
      new ReplayWorld(events);
    } catch (err) {
      caught = notALog(err);
    }
    assert.match(caught?.message ?? "", /^not a session log/);
  }
});

test("an access code is taken out of its field when it is read", () => {
  const field = { value: "  open sesame  " };
  assert.equal(takeValue(field), "open sesame");
  assert.equal(field.value, "");
  assert.equal(takeValue(field), "");
});

test("what the host offers decides how a mind is woken", () => {
  assert.equal(hostMind({ available: true, code: false }), "open", "the local server: wake at once");
  assert.equal(hostMind({ available: true }), "open");
  assert.equal(hostMind({ available: true, code: true }), "code", "Vercel with a code: ask for it");
  assert.equal(hostMind({ available: false, code: true }), "none");
  assert.equal(hostMind({ available: "yes" }), "none");
  assert.equal(hostMind(null), "none", "no answer, or a failed request");
  assert.equal(hostMind(undefined), "none");
});

const SPENT = "This host has spent its $10 limit on the mind, so the mind stays asleep.";

test("the start card says what the host may still spend, or why there is no mind", () => {
  const still = "The first waking, the wiring test and session logs still work.";
  assert.deepEqual(hostNote({ available: true, code: true, limit_usd: 10, spent_usd: 3.12 }),
    { noMind: null, budget: "This host spends at most $10.00 on the mind; $6.88 is left." });
  assert.deepEqual(hostNote({ available: true, code: true, limit_usd: 10, spent_usd: 11 }).budget,
    "This host spends at most $10.00 on the mind; $0.00 is left.");
  assert.deepEqual(hostNote({ available: true, code: true, limit_usd: 2.5 }).budget, "This host spends at most $2.50 on the mind.");
  assert.deepEqual(hostNote({ available: true, code: false }), { noMind: null, budget: null }, "the local server: no limit line");
  assert.deepEqual(hostNote({ available: false, code: true, limit_usd: 10, spent_usd: 10, reason: SPENT }),
    { noMind: `${SPENT} ${still}`, budget: null });
  assert.equal(hostNote({ available: false, code: true, limit_usd: 10,
    reason: "This host cannot count what the mind spends, so the mind stays asleep." }).noMind,
  `This host cannot count what the mind spends, so the mind stays asleep. ${still}`);
  assert.equal(hostNote(null).noMind, `No mind is connected on this host, so a live session cannot start here. ${still}`);
  assert.equal(hostNote({ available: false, reason: "  " }).noMind.startsWith("No mind is connected"), true);
});

test("a 402 from the host shows the host's reason, plainly", () => {
  assert.equal(hostRefusal(`HTTP 402: ${SPENT}`), SPENT);
  assert.equal(hostRefusal("HTTP 401: invalid x-api-key"), null);
  assert.equal(hostRefusal(null), null);
  const obs = observe([HEADER, WAKE, { type: "api_error", t: 0.5, turn: 1, attempt: 1, error: `HTTP 402: ${SPENT}` },
    { type: "turn_end", t: 0.5, turn: 1, tool_calls: 0, capped: false, skipped: true }]);
  assert.equal(mindFailing(obs), true, "not retried, so the banner shows at once");
  assert.deepEqual(mindStatus(obs, 1, makeView({ observer: obs })), ["asleep", [236, 170, 84], "the host's spending limit is reached"]);
  const ctx = fakeCanvas();
  draw(ctx, snapOf(), makeView({ observer: obs, intro: 0 }), { width: 1280, height: 800, dpr: 1 });
  const texts = ctx.ops.filter((op) => op[0] === "fillText").map((op) => op[1]).join(" ");
  assert.match(texts, /This host has spent its \$10 limit on the mind, so the mind stays\s+asleep\. The body is fine/);
  assert.doesNotMatch(texts, /HTTP 402|cannot be reached/, "no error code, no talk of a network");
});

test("the page never asks for an Anthropic key, and talks only to its own host", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /api[- ]?key|sk-ant|api\.anthropic\.com/i);
  assert.deepEqual([...html.matchAll(/type="password"[^>]*/g)].length, 1, "one secret field: the access code");
  assert.match(html, /id="access-code" type="password"/);
  for (const file of ["app.js", "ui-start.js", "ui-session.js", "ui-loop.js"]) {
    const js = readFileSync(new URL(`../lab/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(js, /apiKey|api\.anthropic\.com|https?:\/\//, file);
  }
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
const CTX_PROPS = new Set(["fillStyle", "strokeStyle", "lineWidth", "lineJoin", "font", "textBaseline", "textAlign",
  "globalAlpha", "globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality"]);

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
const SIZES = [[1280, 800, 1], [1920, 1080, 2], [390, 844, 3], [844, 390, 2], [200, 160, 1]];

/** A snapshot and a view for every state the room can be in. */
function sceneTable() {
  const near = LAY.toPixels([9.4, 5.2]);
  const err = (attempt) => ({ type: "api_error", t: 8 + attempt, turn: 1, attempt, error: "HTTP 529: Overloaded" });
  return {
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
}

test("every scene draws without an error, on a desktop and on a phone", () => {
  const scenes = sceneTable();
  for (const [width, height, dpr] of SIZES) {
    for (const [name, [snap, view]] of Object.entries(scenes)) {
      const ctx = fakeCanvas();
      const lay = draw(ctx, snap, view, { width, height, dpr });
      assert.ok(ctx.ops.length > 64, `${name} at ${width}x${height} drew something`);
      if (view.panel && !view.clean) assert.ok(lay.panelInfo, `${name}: the panel was drawn`);
      if (name === "dryrun" || name === "clean") {
        assert.ok(ctx.ops.some((op) => op[0] === "fillText" && /not an AI/.test(op[1])), `${name}: labelled not an AI`);
      }
      if (name === "badKey" && width >= 844) {
        assert.ok(ctx.ops.some((op) => op[0] === "fillText" && op[1] === "The host's key or the access code was not accepted."),
          `${name} at ${width}x${height}: says the key or code was refused`);
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

// --- the 3D view -------------------------------------------------------------------
const near6 = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
const middle = (quad) => [0, 1].map((i) => quad.reduce((sum, p) => sum + p[i], 0) / quad.length);
const topOf = (cam, r, c, h) => Object.fromEntries(cam.faces(r, c, h)).top;
const flat = () => restingSnapshot().actual;
const layout3d = (size = { width: 1280, height: 800 }) => layout(size, false, 8, 8, true);

/** The polygons a drawing filled, in order, each with its fill and the stroke drawn on the same path. */
function polygons(ops) {
  const out = [];
  let path = null;
  let fill = null;
  let stroke = null;
  for (const op of ops) {
    if (op[0] === "set" && op[1] === "fillStyle") fill = op[2];
    else if (op[0] === "set" && op[1] === "strokeStyle") stroke = op[2];
    else if (op[0] === "beginPath") path = { points: [], fill: null, stroke: null };
    else if (!path) continue;
    else if (op[0] === "moveTo" || op[0] === "lineTo") path.points.push([op[1], op[2]]);
    else if (op[0] === "fill") out.push(Object.assign(path, { fill }));
    else if (op[0] === "stroke") path.stroke = stroke;
  }
  return out;
}

test("F3's layout adds the desktop's camera and keeps everything else; the top view has none", () => {
  for (const c of cameraCases) {
    const size = { width: c.size[0], height: c.size[1] };
    const where = `${c.size.join("x")} panel=${c.panel} grid=${c.args[0]}x${c.args[1]}`;
    const top = layout(size, c.panel, c.args[0], c.args[1]);
    const lay = layout(size, c.panel, c.args[0], c.args[1], true);
    assert.ok(lay.camera instanceof Camera, where);
    for (const key of ["k", "ox", "oy"]) {
      assert.ok(near6(lay.camera[key], c.camera[key]), `${key} ${where}: ${lay.camera[key]} != ${c.camera[key]}`);
    }
    assert.equal(top.camera, null, `top view ${where}`);
    assert.equal(layout(size, c.panel, c.args[0], c.args[1], false).camera, null);
    for (const key of ["room", "grid", "panel"]) assert.deepEqual(box(lay[key]), box(top[key]), `${key} ${where}`);
    assert.deepEqual([lay.pitch, lay.u, lay.compact], [top.pitch, top.u, top.compact], where);
  }
  assert.equal(makeView().view3d, false, "the top view is the default");
});

test("on a phone the 3D body stays inside the room, above the typing line", () => {
  for (const [w, h] of [[390, 844], [360, 640], [320, 568], [844, 390], [667, 375]]) {
    for (const panel of [false, true]) {
      const lay = layout({ width: w, height: h }, panel, 8, 8, true);
      const [x, y, bw, bh] = lay.camera.bounds();
      const where = `${w}x${h} panel=${panel}`;
      assert.ok(x >= lay.room.x && x + bw <= lay.room.right, `inside the room's width ${where}`);
      assert.ok(y >= lay.room.y && y + bh <= typingY(lay), `above the typing line ${where}`);
    }
  }
});

test("in the 3D view the person is the floor point under the pointer, whatever the pins do", () => {
  const lay = layout3d();
  for (const pos of [[0, 0], [2.5, 3.25], [7.9, 7.9], [9.4, 5.2], [-1.5, -2]]) {
    const px = lay.toPixels(pos);
    assert.deepEqual(px, lay.camera.project(pos[1], pos[0], 0));
    const back = lay.toPinUnits(px);
    assert.ok(near6(back[0], pos[0]) && near6(back[1], pos[1]), `round trip ${pos}: ${back}`);
  }
  const px = [700, 420];
  const before = lay.toPinUnits(px);
  lay.heights = swell(1.4);
  assert.deepEqual(lay.toPinUnits(px), before, "the pins' heights cannot move the person");
});

test("in the 3D view a press goes to the pin drawn under the pointer", () => {
  const lay = layout3d();
  const cam = lay.camera;
  const px = middle(topOf(cam, 6, 2, 1));
  assert.equal(lay.heights, null, "before the first frame every pin lies flat");
  assert.deepEqual(lay.pinAt(px), cam.pick(px, []));
  const heights = flat();
  heights[6][2] = 1;
  lay.heights = heights;
  assert.deepEqual(lay.pinAt(px), [6, 2], "the top of a raised pin");
  assert.deepEqual(lay.pinAt(lay.toPixels([1.5, 4.95])), [1, 4], "over a gap, the cell of the floor point");
  assert.equal(lay.pinAt(lay.toPixels([-1, 4])), null, "off the grid");
  assert.equal(lay.heightOf([6, 2]), 1);
  assert.equal(lay.heightOf([6, 3]), 0);
  heights[6][3] = 1.7;
  assert.equal(lay.heightOf([6, 3]), 1, "read as the drawing reads it");
  assert.equal(lay.heightOf([9, 9]), 0);
  assert.deepEqual(lay.touch(px), [[6, 2], 1], "a new press: the pin, and its height as the press begins");
  const hold = [[6, 2], 0.8];
  assert.equal(lay.touch(px, hold), hold, "on the same pin: the press as it began");
  assert.equal(lay.touch(lay.toPixels([-1, 4]), hold), null, "off the body: no press");
});

test("a press in the 3D view stays on its pin while the pin sinks, and moves off it with the pointer", () => {
  const lay = layout3d();
  const cam = lay.camera;
  const heights = flat();
  heights[6][2] = 1;
  lay.heights = heights;
  const px = middle(topOf(cam, 6, 2, 1));
  const p = new Pointer();
  p.down(...px, "mouse");
  assert.deepEqual(p.pressed(lay), [6, 2], "the top of a tall pin presses that pin");
  assert.deepEqual(p.hold, [[6, 2], 1]);
  const person = p.person(lay);
  heights[6][2] = 0.2;          // the pin sinks under the press
  assert.notDeepEqual(lay.pinAt(px), [6, 2], "a new press there would land behind it");
  assert.deepEqual(p.pressed(lay), [6, 2], "the press stays on its pin");
  assert.deepEqual(p.pressed(lay), [6, 2], "tick after tick");
  assert.deepEqual(p.hold, [[6, 2], 1], "with the outline it had when the press began");
  assert.deepEqual(p.person(lay), person, "the person stays where they were");
  const away = middle(topOf(cam, 1, 6, 0));
  p.move(...away, "mouse");
  assert.deepEqual(p.pressed(lay), [1, 6], "moving off the pin moves the press");
  p.up("mouse");
  assert.equal(p.hold, null);
  assert.equal(p.pressed(lay), null);
});

test("a press in the 3D view stays on its pin when a neighbour rises in front of it", () => {
  const lay = layout3d();
  const heights = flat();
  heights[6][2] = 0.3;
  lay.heights = heights;
  const px = middle(topOf(lay.camera, 6, 2, 0.3));
  const p = new Pointer();
  p.down(...px, "mouse");
  assert.deepEqual(p.pressed(lay), [6, 2]);
  heights[7][2] = 1;            // the pin in front rises between the camera and the press
  assert.deepEqual(lay.pinAt(px), [7, 2], "it now hides the pressed pin's top");
  assert.deepEqual(p.pressed(lay), [6, 2], "the press stays where it began");
  p.down(...px, "mouse");       // a new press, as if the last release never arrived
  assert.deepEqual(p.pressed(lay), [7, 2], "a new press takes the pin drawn there now");
  p.leave();
  assert.equal(p.hold, null, "leaving ends the press");
  assert.equal(p.pressed(lay), null);
  p.down(...px, "mouse");
  assert.deepEqual(p.pressed(lay), [7, 2], "a new press takes the pin now drawn there");
});

test("in the top view a press is the pin under the pointer, as before", () => {
  const hold = [[3, 3], 1];
  for (let y = -0.6; y < 9; y += 0.37) {
    for (let x = -0.6; x < 9; x += 0.41) {
      const px = LAY.toPixels([y, x]);
      assert.deepEqual(LAY.touch(px, hold)?.[0] ?? null, LAY.pinAt(px), `at ${y},${x}`);
      assert.deepEqual(LAY.pinAt(px, 8, 8, hold), LAY.pinAt(px), "hold is ignored");
    }
  }
  const p = new Pointer();
  p.down(...pinPx(3, 3), "mouse");
  assert.deepEqual(p.pressed(LAY), [3, 3]);
  p.move(...pinPx(3, 4), "mouse");
  assert.deepEqual(p.pressed(LAY), [3, 4], "the press follows the pointer at once");
});

test("draw remembers the heights it drew, in the view the visitor chose", () => {
  const snap = snapOf();
  const size = { width: 1280, height: 800, dpr: 1 };
  const top = draw(fakeCanvas(), snap, makeView({ intro: 0 }), size);
  assert.equal(top.camera, null);
  assert.equal(top.heights, snap.actual);
  const lay = draw(fakeCanvas(), snap, makeView({ intro: 0, view3d: true }), size);
  assert.ok(lay.camera instanceof Camera);
  assert.equal(lay.heights, snap.actual);
});

test("the 3D body: the plate, light lying on it, then each pin's faces from back to front", () => {
  const lay = layout({ width: 1280, height: 800, dpr: 2 }, false, 8, 8, true);
  const cam = lay.camera;
  const actual = flat();
  actual[6][2] = 1;
  actual[3][5] = 0.5;
  const tint = [120, 170, 255];
  const ctx = fakeCanvas();
  drawBody(ctx, snapOf({ actual, color: tint }), lay);

  const [plateTop, plateFront] = cam.plate();
  const want = [
    { points: plateTop, fill: css(PLATE), stroke: css(PLATE_EDGE) },
    { points: plateFront, fill: css(mix(PLATE, BLACK, 0.45)), stroke: null },
  ];
  const shade = { top: 0, front: 0.42, left: 0.30, right: 0.55 };
  for (const [r, c] of cam.order()) {
    const h = actual[r][c];
    const face = pinFace(h, tint);
    for (const [kind, points] of cam.faces(r, c, h)) {
      const fill = css(mix(face, BLACK, shade[kind]));
      want.push({ points, fill, stroke: kind === "top" ? css(mix(face, WHITE, 0.05 + 0.2 * h)) : fill });
    }
  }
  assert.deepEqual(polygons(ctx.ops), want, "every face the camera sees, in its order, and nothing else: no shadows");
  assert.deepEqual(cam.faces(6, 2, 1).map(([kind]) => kind), ["right", "front", "top"], "the raised pin shows three faces");

  // The glow: one ellipse per raised pin, on the plate, added to it.
  const at = (name) => ctx.ops.flatMap((op, i) => (op[0] === name ? [i] : []));
  const spots = at("fillRect");
  assert.equal(spots.length, 2, "light from the raised pins only");
  assert.ok(at("fill")[1] < spots[0] && spots[1] < at("fill")[2], "after the plate, before the pins");
  assert.ok(ctx.ops.some((op) => op[0] === "set" && op[1] === "globalCompositeOperation" && op[2] === "lighter"));
  assert.equal(at("save").length, at("restore").length);
  const transforms = ctx.ops.filter((op) => op[0] === "setTransform");
  [[3, 5], [6, 2]].forEach(([r, c], i) => {
    const [, a, b, cc, d, e, f] = transforms[i];
    const [x, y] = cam.project(c + 0.5, r + 0.5, 0);
    assert.ok(near6(e, 2 * x) && near6(f, 2 * y), "centred on the pin's foot, at the device pixel ratio");
    const wide = cam.project(c + 1.7, r + 0.5, 0)[0] - cam.project(c - 0.7, r + 0.5, 0)[0];
    const deep = cam.project(c + 0.5, r + 1.7, 0)[1] - cam.project(c + 0.5, r - 0.7, 0)[1];
    const gd = Math.max(4, Math.trunc(lay.pitch * 2.4));
    assert.deepEqual([b, cc], [0, 0]);
    assert.ok(near6(a * gd, 2 * wide) && near6(d * gd, 2 * deep), "as wide and as deep as the 2.4 x 2.4 square around it");
    assert.ok(a > d, "an ellipse lying on the plate");
  });
});

test("the honesty rule holds in the 3D view: a pin is drawn from its height and the colour, and nothing else", () => {
  const lay = layout({ width: 1280, height: 800, dpr: 2 }, false, 8, 8, true);
  const actual = swell(0.7);
  const opsOf = (snap) => {
    const ctx = fakeCanvas();
    drawBody(ctx, snap, lay);
    return JSON.stringify(ctx.ops);
  };
  const base = opsOf(snapOf({ actual, t: 3 }));
  // Time, the person, a pressed pin, the orders, the trace and the pointer's picking change nothing.
  assert.equal(opsOf({ ...snapOf({ actual, t: 812.4, person: [4.5, 4.5], pressed: [4, 4] }),
    target: swell(2.5), gap_max: swell(1.1) }), base);
  lay.heights = swell(2.5);
  assert.equal(opsOf(snapOf({ actual, t: 3 })), base);
  // The real heights and the colour do.
  assert.notEqual(opsOf(snapOf({ actual: swell(1.9), t: 3 })), base);
  assert.notEqual(opsOf(snapOf({ actual, t: 3, color: [255, 196, 150] })), base);
});

test("every scene draws in the 3D view too, at every size", () => {
  const scenes = sceneTable();
  for (const [width, height, dpr] of SIZES) {
    for (const [name, [snap, view]] of Object.entries(scenes)) {
      const ctx = fakeCanvas();
      const lay = draw(ctx, snap, { ...view, view3d: true }, { width, height, dpr });
      const where = `${name} at ${width}x${height}`;
      assert.ok(lay.camera, where);
      assert.ok(polygons(ctx.ops).filter((q) => q.points.length === 4).length >= 2 + 64, `${where}: the plate and every pin`);
      if (view.panel && !view.clean) assert.ok(lay.panelInfo, `${where}: the panel was drawn`);
      if (name === "dryrun" || name === "clean") {
        assert.ok(ctx.ops.some((op) => op[0] === "fillText" && /not an AI/.test(op[1])), `${where}: labelled not an AI`);
      }
      if (name === "badKey" && width >= 844) {
        assert.ok(ctx.ops.some((op) => op[0] === "fillText" && op[1] === "The host's key or the access code was not accepted."),
          `${where}: says the key or code was refused`);
      }
      if (view.mode === "replay" && snap.person) {
        const [x, y] = lay.camera.project(snap.person[1], snap.person[0], 0);
        assert.ok(ctx.ops.some((op) => op[0] === "arc" && op[1] === Math.trunc(x) + 0.5 && op[2] === Math.trunc(y) + 0.5),
          `${where}: the recorded visitor stands on the floor point`);
      }
    }
  }
});

test("F3 switches the view wherever the focus is; the help says so", () => {
  for (const more of [{}, { typing: true }, { onControl: true }, { replay: true }, { helpOpen: true }, { start: true },
    { start: true, shift: true }]) {
    assert.equal(keyAction({ key: "F3", ...more }), "view3d", JSON.stringify(more));
  }
  for (const key of ["F1", "F2", "Tab", "Escape", " ", "Enter", "a"]) {
    assert.equal(keyAction({ key, start: true }), null, `on the start screen ${JSON.stringify(key)} is the card's`);
  }
  const helpTexts = (over) => {
    const ctx = fakeCanvas();
    draw(ctx, snapOf(), makeView({ intro: 0, help: true, ...over }), { width: 1280, height: 800, dpr: 1 });
    return ctx.ops.filter((op) => op[0] === "fillText").map((op) => op[1]);
  };
  for (const over of [{}, { mode: "replay" }, { view3d: true }]) {
    const keys = helpTexts(over);
    const f3 = keys.indexOf("F3");
    assert.ok(keys.indexOf("F2") < f3 && f3 < keys.indexOf("F11"), "F3 comes after F2");
    assert.equal(keys[f3 + 1], "3D view: see how high each pin stands; F3 again for the top view");
  }
  const touch = helpTexts({ touch: true });
  assert.equal(touch[touch.indexOf("3D view") + 1], "see how high each pin stands");
});

test("the page has a 3D view button after Observer, and every new view starts in the view last chosen", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /aria-keyshortcuts="Tab">Observer<\/button>\s*<button type="button" data-act="view3d" aria-pressed="false" aria-keyshortcuts="F3">3D view<\/button>/);
  const app = readFileSync(new URL("../lab/app.js", import.meta.url), "utf8");
  const views = [...app.matchAll(/makeView\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(views.length >= 4, "the start view, the preview, a replay and a live session");
  for (const v of views) assert.match(v, /\bview3d\b/, v);
});

test("only the person moves a press: a pin rising under a still pointer neither takes it over nor starts one", () => {
  const lay = layout({ width: 1280, height: 800 }, false, 8, 8, true);
  const flat = () => Array.from({ length: 8 }, () => new Array(8).fill(0));
  const p = new Pointer();
  lay.heights = flat();
  const gap = lay.toPixels([5.95, 2.5]);                 // between rows 5 and 6, column 2
  p.move(gap[0], gap[1], "mouse");
  p.down(gap[0], gap[1], "mouse");
  assert.deepEqual(p.pressed(lay), [5, 2]);
  lay.heights[6][2] = 0.6;                                // the pin in front rises over the pointer
  assert.ok(lay.camera.covers(gap, 6, 2, 0.6));
  assert.deepEqual(p.pressed(lay), [5, 2]);              // the pointer is still: the press stays
  p.move(gap[0] + 0.5, gap[1], "mouse");                 // a tremble, still over its own cell of the floor
  assert.deepEqual(p.pressed(lay), [5, 2]);
  p.up("mouse");

  lay.heights = flat();
  const behind = lay.toPixels([-0.6, 3.5]);              // just behind the back row
  p.move(behind[0], behind[1], "mouse");
  p.down(behind[0], behind[1], "mouse");
  assert.equal(p.pressed(lay), null);
  lay.heights[0][3] = 1;                                 // a pin rises under the still pointer
  assert.ok(lay.camera.covers(behind, 0, 3, 1));
  assert.equal(p.pressed(lay), null);                    // no touch begins by itself
});

test("a recorded visitor far beyond the 3D camera is not drawn, and nothing fails", () => {
  for (const row of [20, 40, 1e6]) {
    const ctx = fakeCanvas();
    draw(ctx, snapOf({ person: [row, 4] }), makeView({ mode: "replay", intro: 0, clean: true, view3d: true }),
      { width: 1280, height: 800, dpr: 1 });
    const far = ctx.ops.filter((op) => op[0] === "arc" && (Math.abs(op[1]) >= 1e6 || Math.abs(op[2]) >= 1e6));
    assert.deepEqual(far, [], `row ${row}`);
  }
});
