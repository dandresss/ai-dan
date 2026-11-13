// The body: ports of tests/test_display.py, test_nervous.py, test_contract.py
// and test_simbody.py, then Python's own scripted runs (fixtures/body.json)
// reproduced call for call, hash for hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Config } from "../lab/config.js";
import { Display } from "../lab/display.js";
import { NervousSystem } from "../lab/nervous.js";
import { pyDumps, pyRound } from "../lab/py.js";
import { SimBody } from "../lab/simbody.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/body.json", import.meta.url), "utf8"));

const approx = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not about ${expected}`);
const repeat = (n, f) => { for (let k = 0; k < n; k++) f(k); };
const fill = (h) => new Array(64).fill(h);
const ALL = Array.from({ length: 64 }, (_, i) => i);

// --- config --------------------------------------------------------------------
test("Config: Python's fields, defaults and order; derived values", () => {
  const config = new Config();
  assert.deepEqual(Object.keys(config.toDict()), [
    "GRID_ROWS", "GRID_COLS", "LEVELS", "FULL_TRAVEL_S", "TICK_HZ", "RESPONSE_MS", "DEFAULT_COLOR",
    "MAX_TRACKS", "MAX_KEYFRAMES", "MAX_TRACK_S", "PULSE_S", "ABSENCE_GRACE_S", "MAX_TOOL_CALLS",
    "MAX_TURNS", "MAX_SESSION_MIN", "MEMORY_FULL_TURNS", "MAX_TOKENS", "MODEL", "EFFORT", "THINKING",
    "PROMPT_VERSION", "LANGUAGE", "MEMORY_ENABLED", "NOTE_MAX_CHARS", "STATE_EVERY_TICKS"]);
  const header = JSON.parse(readFileSync(new URL("../sessions/first-wake.jsonl", import.meta.url), "utf8").split("\n")[0]);
  assert.equal(pyDumps(config.toDict()), pyDumps(header.config));
  assert.equal(config.nPins, 64);
  assert.equal(config.maxStep, 0.04);
  assert.equal(config.responseTicks, 4);
  assert.equal(config.timeOf(1), 0.02);
  assert.equal(config.tickOf(0.03), 2);           // round(1.5) == 2
  assert.equal(config.tickOf(0.05), 2);           // round(2.5) == 2
  assert.equal(new Config({ RESPONSE_MS: 312.5, TICK_HZ: 8 }).responseTicks, 2);
  assert.equal(new Config({ TICK_HZ: 8 }).timeOf(1), 0.12);   // round(0.125, 2) == 0.12
  assert.throws(() => new Config({ GRID_ROWZ: 3 }), TypeError);
  const copy = Config.fromDict({ ...config.toDict(), PULSE_S: 8.0, unknown: 1 });
  assert.equal(copy.PULSE_S, 8.0);
  assert.equal(copy.unknown, undefined);
  copy.DEFAULT_COLOR[0] = 0;
  assert.deepEqual(new Config().DEFAULT_COLOR, [255, 255, 255]);
});

// --- display (shape-display.md, criteria 1 to 7) -------------------------------------
const display = () => new Display(new Config());
const run = (d, heights, ticks) => repeat(ticks, () => d.step(heights));

test("display 1: an order from 0 to 1 completes in half a second plus the response delay", () => {
  const d = display();
  const cfg = new Config();
  let steps = 0;
  while (d.actual[0] < 1.0) {
    d.step(fill(1.0));
    steps += 1;
  }
  assert.ok(Math.abs(steps - (cfg.responseTicks + pyRound(cfg.FULL_TRAVEL_S * cfg.TICK_HZ))) <= 1);
  assert.equal(d.actual[0], 1.0);
});

test("display 2: an oscillation faster than one cycle a second never reaches the extremes", () => {
  const d = display();
  const seen = [];
  repeat(200, (k) => {
    d.step(fill(Math.floor(k / 10) % 2 === 0 ? 1.0 : 0.0));
    seen.push(d.actual[0]);
  });
  assert.ok(Math.max(...seen) < 0.5 && Math.max(...seen) - Math.min(...seen) < 0.5);
});

test("display 3: a pushed pin differs from its target and recovers on release", () => {
  const d = display();
  run(d, fill(0.5), 60);
  approx(d.actual[0], 0.5, 0.01);
  d.pressed = [0, 0];
  run(d, fill(0.5), 5);
  assert.ok(d.actual[0] < d.target[0] - 0.1);
  assert.ok(Math.abs(d.actual[1] - d.target[1]) < 0.01);
  d.pressed = null;
  run(d, fill(0.5), 20);
  assert.equal(d.actual[0], d.target[0]);
});

test("display 4: reported heights take only 64 distinct values", () => {
  const d = display();
  const seen = new Set();
  repeat(400, (k) => {
    d.step(fill((k % 100) / 99));
    for (const row of d.sense().actual) row.forEach((v) => seen.add(v));
  });
  const levels = new Set(Array.from({ length: 64 }, (_, i) => Math.round((i / 63) * 100) / 100));
  assert.ok(seen.size > 2 && seen.size <= 64);
  assert.ok([...seen].every((v) => levels.has(v)));
});

test("display 5: person is null without a mouse, one decimal with one", () => {
  const d = display();
  assert.equal(d.sense().person, null);
  d.person = [3.24, 9.16];
  assert.deepEqual(d.sense().person, [3.2, 9.2]);
  d.person = [2.25, -0.75];                        // ties: Python rounds them to even
  assert.deepEqual(d.sense().person, [2.2, -0.8]);
  d.person = null;
  assert.equal(d.sense().person, null);
});

test("display 6: same orders and inputs give the same result", () => {
  const go = () => {
    const d = display();
    repeat(200, (k) => {
      d.pressed = k >= 80 && k < 95 ? [2, 2] : null;
      d.step(fill((k % 37) / 36));
    });
    return d.state();
  };
  assert.deepStrictEqual(go(), go());
});

test("display 7: a brief touch shows on the next read and is zero on the one after", () => {
  const d = display();
  run(d, fill(0.5), 60);
  d.sense();
  d.pressed = [4, 4];
  run(d, fill(0.5), 5);
  d.pressed = null;
  run(d, fill(0.5), 40);
  assert.ok(d.sense().gap[4][4] > 0.1);
  assert.equal(d.sense().gap[4][4], 0.0);
});

test("display: speed limit, quantization on arrival, clipping", () => {
  const d = display();
  d.step(fill(0.5));
  assert.equal(d.target[0], pyRound(0.5 * 63) / 63);
  let previous = 0.0;
  repeat(10, () => {
    d.step(fill(1.0));
    assert.ok(d.actual[0] - previous <= d.config.maxStep + 1e-9);
    previous = d.actual[0];
  });
  run(d, fill(7.0), 60);
  assert.ok(d.target[0] === 1.0 && d.actual[0] === 1.0);
  run(d, fill(-3.0), 60);
  assert.ok(d.target[0] === 0.0 && d.actual[0] === 0.0);
});

test("display: a pin at zero cannot be pushed lower; a pushed pin falls at the speed limit", () => {
  const d = display();
  d.pressed = [0, 0];
  run(d, fill(0.0), 10);
  assert.equal(d.sense().gap[0][0], 0.0);
  const e = display();
  run(e, fill(1.0), 40);
  e.pressed = [1, 1];
  e.step(fill(1.0));
  approx(e.actual[9], 1.0 - e.config.maxStep);
});

test("display: deviation is against the latest order; snapshot never resets the trace", () => {
  const d = display();
  d.color = [1, 2, 3];
  d.step(fill(1.0));
  assert.equal(d.gapMax[0], 1.0);
  const snap = d.snapshot(1, 0.02);
  assert.ok(snap.gap_max[0][0] === 1.0 && d.gapMax[0] === 1.0);
  assert.deepEqual(d.sense().color, [1, 2, 3]);
  assert.equal(d.gapMax[0], 0.0);
});

// --- nervous system (nervous-system.md, criteria 1 to 7) -------------------------------
const track = (keyframes, { pins = ALL, loop = false, ease = "smooth", delay_s = 0.0 } = {}) =>
  ({ pins, keyframes, loop, ease, delay_s });
const nervous = () => new NervousSystem(new Config());

test("nervous 1: with no calls all heights stay zero", () => {
  const ns = nervous();
  repeat(500, (k) => assert.deepEqual(ns.heights(k / 50), fill(0.0)));
});

test("nervous 2: a smooth loop is an exact sinusoid", () => {
  const ns = nervous();
  ns.play([track([[0, 0.2], [2, 0.8], [4, 0.2]], { loop: true })], 0.0);
  for (const [second, expected] of [[0, 0.2], [1, 0.5], [2, 0.8], [3, 0.5], [4, 0.2], [5, 0.5]]) {
    approx(ns.heights(second)[0], expected);
  }
});

test("nervous 3: a track without loop ends and holds its last height", () => {
  const ns = nervous();
  ns.play([track([[0, 0.0], [1, 0.7]])], 0.0);
  approx(ns.heights(0.5)[0], 0.35);
  for (const t of [1.0, 1.02, 5.0, 100.0]) approx(ns.heights(t)[0], 0.7);
  assert.equal(ns.pins[0].keyframes, null);
  approx(ns.pins[0].hold, 0.7);
});

test("nervous 4: a delay holds the height until the wait is over", () => {
  const ns = nervous();
  ns.play([track([[0, 0.0], [1, 0.6]])], 0.0);
  ns.heights(2.0);
  ns.play([track([[0, 0.1], [1, 0.9]], { delay_s: 3.0 })], 2.0);
  for (const t of [2.0, 3.0, 4.9]) approx(ns.heights(t)[0], 0.6);
  approx(ns.heights(5.0)[0], 0.1);
  approx(ns.heights(6.0)[0], 0.9);
});

test("nervous 4: a pin named twice in one call waits at the height it had", () => {
  const ns = nervous();
  ns.play([track([[0, 1.0], [1, 1.0]]), track([[0, 0.5], [1, 0.5]], { pins: [0], delay_s: 5.0 })], 0.0);
  for (const t of [0.0, 2.0, 4.9]) {
    approx(ns.heights(t)[0], 0.0);
    approx(ns.heights(t)[1], 1.0);
  }
  approx(ns.heights(5.0)[0], 0.5);
});

test("nervous 5: play on a subset leaves the other pins' phase untouched", () => {
  const plain = nervous();
  const touched = nervous();
  const loop = track([[0, 0.2], [2, 0.8], [4, 0.2]], { loop: true });
  plain.play([loop], 0.0);
  touched.play([loop], 0.0);
  touched.play([track([[0, 1.0], [1, 0.0]], { pins: [0, 9], loop: true })], 1.3);
  for (let k = 70; k < 400; k++) {
    const a = plain.heights(k / 50);
    const b = touched.heights(k / 50);
    assert.deepEqual(a.filter((_, i) => i !== 0 && i !== 9), b.filter((_, i) => i !== 0 && i !== 9));
    assert.ok(a[0] !== b[0]);
  }
});

test("nervous 6: stop freezes each pin at its ordered height of that instant", () => {
  const ns = nervous();
  ns.play([track([[0, 0.2], [2, 0.8], [4, 0.2]], { loop: true })], 0.0);
  ns.play([track([[0, 0.0], [1, 1.0]], { pins: [3], ease: "linear", loop: true })], 0.0);
  const before = ns.heights(1.25);
  ns.stop([0, 3], 1.25);
  for (const t of [1.25, 2.0, 9.0]) {
    const after = ns.heights(t);
    approx(after[0], before[0]);
    approx(after[3], before[3]);
    approx(after[3], 0.25);
  }
  assert.notEqual(ns.heights(2.0)[1], before[1]);
});

test("nervous 7: same calls at the same instants give the same heights", () => {
  const go = () => {
    const ns = nervous();
    const out = [];
    for (let k = 0; k < 300; k++) {
      const t = k / 50;
      if (k === 0) ns.play([track([[0, 0.1], [1, 0.9], [3, 0.3]], { loop: true, ease: "linear" })], t);
      if (k === 40) ns.play([track([[0, 0.5], [2, 0.0]], { pins: [5, 6], delay_s: 0.5 })], t);
      if (k === 120) ns.stop([5], t);
      out.push(ns.heights(t));
    }
    return out;
  };
  assert.deepStrictEqual(go(), go());
});

test("nervous: linear is constant speed, smooth is slow at the keyframes; a new track replaces the old", () => {
  const ns = nervous();
  ns.play([track([[0, 0.0], [1, 1.0]], { pins: [0], ease: "linear" }),
    track([[0, 0.0], [1, 1.0]], { pins: [1], ease: "smooth" })], 0.0);
  approx(ns.heights(0.25)[0], 0.25);
  assert.ok(ns.heights(0.1)[1] < 0.1);
  const other = nervous();
  other.play([track([[0, 0.0], [1, 1.0]], { ease: "linear" })], 0.0);
  other.play([track([[0, 0.0], [1, 0.0]], { delay_s: 1.0 })], 0.5);
  approx(other.heights(1.0)[0], 0.5);
});

// --- contract (body-contract.md, criteria 1 to 5, and the error table) -------------------
const NO_POINT = "That point does not exist in your body.";
const TOO_MANY = "That is too many movements at once.";
const TOO_LONG = "That movement is too long to remember.";
const BAD_MOVE = "That movement cannot be understood.";
const BAD_COLOR = "That color cannot be understood.";
const KF = [[0, 0.2], [1, 0.8]];
const body = () => new SimBody(new Config());
const steps = (b, n) => repeat(n, () => b.step());
const play = (b, fields = {}) => b.call("play", { tracks: [{ pins: "all", keyframes: KF, ...fields }] });

test("contract 1: all pins, three keyframes, loop: rise and fall across senses", () => {
  const b = body();
  assert.deepEqual(play(b, { keyframes: [[0, 0.1], [1, 0.9], [2, 0.1]], loop: true }), { ok: true, t: 0.0 });
  const seen = {};
  for (let k = 1; k <= 100; k++) {
    b.step();
    if ([25, 50, 75, 100].includes(k)) seen[k] = b.call("sense").actual[0][0];
  }
  assert.ok(seen[25] < seen[50] && seen[75] < seen[50] && seen[100] < seen[75]);
});

test("contract 2: a brief touch shows in the next gap and not the one after", () => {
  const b = body();
  play(b, { keyframes: [[0, 0.5], [1, 0.5]] });
  steps(b, 60);
  b.call("sense");
  b.setPressed([2, 3]);
  steps(b, 5);
  b.setPressed(null);
  steps(b, 40);
  assert.ok(b.call("sense").gap[2][3] > 0.1);
  assert.equal(b.call("sense").gap[2][3], 0.0);
});

test("contract 3: play on a subset does not alter the rest", () => {
  const rest = (second) => {
    const b = body();
    play(b, { keyframes: [[0, 0.2], [2, 0.8], [4, 0.2]], loop: true });
    const out = [];
    for (let k = 0; k < 200; k++) {
      if (k === 70 && second) play(b, { pins: [[0, 0]], keyframes: [[0, 1], [1, 0]], loop: true });
      b.step();
      out.push(b.snapshot().actual.flat().slice(1));
    }
    return out;
  };
  assert.deepStrictEqual(rest(false), rest(true));
});

test("contract 4: an invalid call returns an error and leaves the body exactly as it was", () => {
  const b = body();
  play(b, { keyframes: [[0, 0.2], [2, 0.8]], loop: true });
  steps(b, 30);
  const before = b.stateHash();
  const result = b.call("play", { tracks: [{ pins: [[0, 0]], keyframes: KF }, { pins: [[9, 9]], keyframes: KF }] });
  assert.deepEqual(result, { ok: false, t: 0.6, error: NO_POINT });
  assert.equal(b.stateHash(), before);
  for (const [name, args] of [["set_color", { rgb: [1, 2, 300] }], ["stop", { pins: [[0, 8]] }], ["dance", {}]]) {
    assert.equal(b.call(name, args).ok, false);
    assert.equal(b.stateHash(), before);
  }
});

test("contract 5: results are plain JSON with no simulator detail", () => {
  const b = body();
  const results = [play(b), b.call("stop", null), b.call("set_color", { rgb: [1, 2, 3] }),
    b.call("sense"), play(b, { keyframes: [[1, 0], [2, 1]] })];
  for (const r of results) assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
  assert.deepEqual(Object.keys(results[3]), ["t", "actual", "gap", "person", "color"]);
  assert.equal(results[3].actual.length, 8);
  assert.equal(results[3].actual[0].length, 8);
  assert.equal(results[4].error, BAD_MOVE);
});

const BAD_TRACKS = [
  [{ pins: [[8, 0]], keyframes: KF }, NO_POINT], [{ pins: [[0, 8]], keyframes: KF }, NO_POINT],
  [{ pins: [[-1, 0]], keyframes: KF }, NO_POINT],
  [{ pins: "all", keyframes: new Array(17).fill([0, 0]) }, TOO_LONG],
  [{ pins: "all", keyframes: [[0, 0], [601, 1]] }, TOO_LONG],
  [{ pins: "all", keyframes: KF, delay_s: 601 }, TOO_LONG],
  [{ pins: "all", keyframes: [[0, 0]] }, BAD_MOVE], [{ pins: "all", keyframes: [] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[1, 0], [2, 1]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [1, 1], [1, 0]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [2, 1], [1, 0]] }, BAD_MOVE],
  [{ keyframes: KF }, BAD_MOVE], [{ pins: "some", keyframes: KF }, BAD_MOVE],
  [{ pins: [], keyframes: KF }, BAD_MOVE], [{ pins: [[0]], keyframes: KF }, BAD_MOVE],
  [{ pins: [[0, 0.5]], keyframes: KF }, BAD_MOVE], [{ pins: [[true, 0]], keyframes: KF }, BAD_MOVE],
  [{ pins: [["0", 0]], keyframes: KF }, BAD_MOVE], [{ pins: "all" }, BAD_MOVE],
  [{ pins: "all", keyframes: "up" }, BAD_MOVE], [{ pins: "all", keyframes: [[0, "a"], [1, 1]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [1, NaN]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [Infinity, 1]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [1, true]] }, BAD_MOVE],
  [{ pins: "all", keyframes: [[0, 0], [1]] }, BAD_MOVE],
  [{ pins: "all", keyframes: KF, delay_s: -1 }, BAD_MOVE],
  [{ pins: "all", keyframes: KF, delay_s: "soon" }, BAD_MOVE],
  [{ pins: "all", keyframes: KF, ease: "bouncy" }, BAD_MOVE],
  [{ pins: "all", keyframes: KF, loop: "yes" }, BAD_MOVE],
  [{ pins: "all", keyframes: KF, loop: 1 }, BAD_MOVE], ["not an object", BAD_MOVE],
];

test("contract: an invalid track is rejected whole, with the exact message", () => {
  for (const [bad, message] of BAD_TRACKS) {
    const b = body();
    const before = b.stateHash();
    const result = b.call("play", { tracks: [{ pins: [[0, 0]], keyframes: KF }, bad] });
    assert.deepEqual(result, { ok: false, t: 0.0, error: message }, JSON.stringify(bad));
    assert.equal(b.stateHash(), before);
  }
});

test("contract: invalid play arguments, colours and stops", () => {
  const plays = [[null, BAD_MOVE], [{}, BAD_MOVE], [{ tracks: null }, BAD_MOVE], [{ tracks: [] }, BAD_MOVE],
    [{ tracks: "x" }, BAD_MOVE], ["play", BAD_MOVE], [[], BAD_MOVE],
    [{ tracks: new Array(17).fill({ pins: "all", keyframes: KF }) }, TOO_MANY]];
  for (const [args, message] of plays) assert.deepEqual(body().call("play", args), { ok: false, t: 0.0, error: message });
  for (const rgb of [null, "red", [1, 2], [1, 2, 3, 4], [-1, 0, 0], [0, 0, 256], [1.5, 0, 0], [true, 0, 0],
    ["1", 2, 3], [NaN, 0, 0], [Infinity, 0, 0], { r: 1 }]) {
    const b = body();
    const before = b.stateHash();
    assert.deepEqual(b.call("set_color", { rgb }), { ok: false, t: 0.0, error: BAD_COLOR });
    assert.equal(b.stateHash(), before);
    assert.equal(b.call("set_color", null).error, BAD_COLOR);
  }
  const b = body();
  assert.equal(b.call("stop", { pins: [[8, 8]] }).error, NO_POINT);
  assert.equal(b.call("stop", { pins: [] }).error, BAD_MOVE);
  assert.equal(b.call("stop", { pins: "most" }).error, BAD_MOVE);
});

test("contract: integral floats are accepted as colours and pin coordinates", () => {
  const b = body();
  assert.equal(b.call("set_color", { rgb: [255.0, 0, 12] }).ok, true);
  assert.deepEqual(b.call("sense").color, [255, 0, 12]);
  assert.equal(play(b, { pins: [[2.0, 3.0]] }).ok, true);
  b.call("set_color", { rgb: [-0.0, 0, 0] });
  assert.ok(Object.is(b.call("sense").color[0], 0));   // Python's int(-0.0) is 0
});

test("contract: stop with no pins stops every pin, and pins null or \"all\" too", () => {
  for (const args of [null, undefined, {}, { pins: null }, { pins: "all" }]) {
    const b = body();
    play(b, { keyframes: [[0, 0], [10, 1]], ease: "linear" });
    steps(b, 25);
    assert.equal(b.call("stop", args).ok, true);
    steps(b, 100);
    assert.ok(b.snapshot().target.flat().every((v) => Math.abs(v - 0.05) < 0.02));
  }
});

test("contract: unknown tools, extra fields, optional fields given as null", () => {
  const b = body();
  assert.deepEqual(b.call("fly", {}), { ok: false, t: 0.0, error: "That cannot be understood." });
  assert.equal(b.call("fly", null).ok, false);
  assert.equal(b.call(null, null).ok, false);
  assert.equal(play(b, { extra: "x" }).ok, true);
  assert.equal(b.call("sense", { anything: 1 }).t, 0.0);
  assert.equal(play(b, { loop: null, ease: null, delay_s: null }).ok, true);
});

test("contract: heights outside the range are clipped; the last of two tracks wins", () => {
  const b = body();
  assert.equal(play(b, { keyframes: [[0, -5], [1, 9]], ease: "linear" }).ok, true);
  steps(b, 120);
  assert.equal(b.snapshot().target[0][0], 1.0);
  const c = body();
  c.call("play", { tracks: [{ pins: [[0, 0]], keyframes: [[0, 1], [1, 1]] }, { pins: [[0, 0]], keyframes: [[0, 0.5], [1, 0.5]] }] });
  steps(c, 5);
  assert.equal(c.snapshot().target[0][0], pyRound(0.5 * 63) / 63);
});

test("contract: the limits themselves are accepted", () => {
  const b = body();
  assert.equal(b.call("play", { tracks: new Array(16).fill({ pins: "all", keyframes: KF }) }).ok, true);
  assert.equal(play(b, { keyframes: Array.from({ length: 16 }, (_, i) => [i, 0.5]), delay_s: 600 }).ok, true);
  assert.equal(play(b, { keyframes: [[0, 0], [600, 1]] }).ok, true);
});

test("contract: garbage never throws", () => {
  const b = body();
  const junk = [null, undefined, 1, 1.5, "x", [], {}, [null], { tracks: [null] }, { tracks: [[]] }, { tracks: [{}] },
    { tracks: [{ pins: {}, keyframes: {} }] }, { rgb: {} }, { pins: Infinity }, { __proto__: null, tracks: 1 },
    { tracks: [{ pins: "all", keyframes: [[Infinity, 0], [1, 1]] }] }, JSON.parse('{"__proto__": {"tracks": 1}}'),
    { tracks: [{ pins: [[Infinity, 0]], keyframes: KF }] }, { constructor: 1, hasOwnProperty: 2 }];
  for (const name of ["play", "stop", "sense", "set_color", "other", null, 5, undefined, {}]) {
    for (const args of junk) assert.equal(typeof b.call(name, structuredClone(args)), "object");
  }
});

// --- SimBody -------------------------------------------------------------------------------
test("simbody: starts flat and still; time follows ticks", () => {
  const b = body();
  assert.deepEqual([b.tick, b.t], [0, 0.0]);
  steps(b, 50);
  assert.deepEqual([b.tick, b.t], [50, 1.0]);
  const snap = b.snapshot();
  assert.deepEqual(snap.actual, new Array(8).fill(new Array(8).fill(0.0)));
  assert.deepEqual(snap.color, [255, 255, 255]);
  assert.ok(snap.person === null && snap.pressed === null);
});

test("simbody: a play is in motion within the step it arrived in", () => {
  const b = body();
  b.call("play", { tracks: [{ pins: "all", keyframes: [[0, 0.8], [1, 0.8]] }] });
  b.step();
  assert.equal(b.snapshot().target[0][0], pyRound(0.8 * 63) / 63);
  assert.equal(b.snapshot().actual[0][0], 0.0);
  steps(b, 4);
  assert.ok(b.snapshot().actual[0][0] > 0);
});

test("simbody: call time is the tick the call was applied in; snapshot never resets the trace", () => {
  const b = body();
  steps(b, 25);
  assert.equal(b.call("stop", null).t, 0.5);
  assert.equal(b.call("sense").t, 0.5);
  const c = body();
  c.call("play", { tracks: [{ pins: [[1, 1]], keyframes: [[0, 1], [1, 1]] }] });
  c.step();
  assert.equal(c.snapshot().gap_max[1][1], 1.0);
  assert.equal(c.snapshot().gap_max[1][1], 1.0);
  assert.equal(c.call("sense").gap[1][1], 1.0);
  assert.equal(c.snapshot().gap_max[1][1], 0.0);
});

test("simbody: person and pressed reach snapshot and sense; snapshots are copies", () => {
  const b = body();
  b.setPerson([3.24, 9.16]);
  b.setPressed([2, 5]);
  const snap = b.snapshot();
  assert.deepEqual(snap.person, [3.24, 9.16]);
  assert.deepEqual(snap.pressed, [2, 5]);
  snap.target[0][0] = 9;
  snap.color[0] = 0;
  assert.equal(b.snapshot().target[0][0], 0.0);
  assert.equal(b.snapshot().color[0], 255);
  assert.deepEqual(b.call("sense").person, [3.2, 9.2]);
  b.setPerson(null);
  assert.equal(b.call("sense").person, null);
});

function script(b, k) {
  if (k === 0) b.call("play", { tracks: [{ pins: "all", keyframes: [[0, 0.1], [1, 0.9], [2, 0.1]], loop: true }] });
  if (k === 30) b.setPerson([2.0, 3.5]);
  if (k === 40) b.call("play", { tracks: [{ pins: [[1, 1], [2, 2]], keyframes: [[0, 1], [3, 0]], delay_s: 1 }] });
  if (k === 60) b.setPressed([1, 1]);
  if (k === 75) b.setPressed(null);
  if (k === 90) b.call("set_color", { rgb: [10, 20, 30] });
  if (k === 100) b.call("sense");
  if (k === 110) b.call("play", { tracks: [{ pins: [[9, 9]], keyframes: [[0, 1], [1, 0]] }] });
  if (k === 150) b.call("stop", { pins: [[0, 0]] });
}

test("simbody: two bodies given the same history have the same hash at every tick", () => {
  const a = body();
  const b = body();
  for (let k = 0; k < 300; k++) {
    script(a, k);
    script(b, k);
    a.step();
    b.step();
    assert.equal(a.stateHash(), b.stateHash());
  }
});

test("simbody: the state hash is 16 hex digits and differs when anything differs", () => {
  const base = body();
  assert.match(base.stateHash(), /^[0-9a-f]{16}$/);
  const variant = (act) => { const b = body(); act(b); return b.stateHash(); };
  const hashes = new Set([base.stateHash(),
    variant((b) => b.step()),
    variant((b) => b.call("set_color", { rgb: [0, 0, 0] })),
    variant((b) => b.setPressed([0, 0])),
    variant((b) => b.call("play", { tracks: [{ pins: [[0, 0]], keyframes: [[0, 0], [1, 1]] }] })),
    variant((b) => b.call("play", { tracks: [{ pins: [[0, 1]], keyframes: [[0, 0], [1, 1]] }] })),
    variant((b) => b.call("play", { tracks: [{ pins: [[0, 0]], keyframes: [[0, 0], [1, 1]], ease: "linear" }] }))]);
  assert.equal(hashes.size, 7);
});

test("simbody: sense changes the hash only through the trace", () => {
  const b = body();
  b.call("play", { tracks: [{ pins: [[0, 0]], keyframes: [[0, 1], [1, 1]] }] });
  b.step();
  const before = b.stateHash();
  b.call("sense");
  assert.notEqual(b.stateHash(), before);
  const again = b.stateHash();
  b.call("sense");
  assert.equal(b.stateHash(), again);
});

// --- Python's own runs ----------------------------------------------------------------------
function decode(x) {
  if (Array.isArray(x)) return x.map(decode);
  if (x !== null && typeof x === "object") {
    if (Object.keys(x).length === 1 && Object.hasOwn(x, "__py__")) {
      return { nan: NaN, inf: Infinity, "-inf": -Infinity }[x.__py__];
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, decode(v)]));
  }
  return x;
}

for (const recorded of fixture.bodies) {
  test(`simbody reproduces Python's scripted run "${recorded.name}": every result, hash and snapshot`, () => {
    const b = new SimBody(new Config(recorded.config));
    let calls = 0;
    let snapshots = 0;
    recorded.ops.forEach((op, i) => {
      const where = `op ${i} (${op.op} ${op.name ?? ""} at tick ${b.tick})`;
      if (op.op === "call") {
        assert.equal(pyDumps(b.call(op.name, decode(op.args))), op.result, `${where}: ${JSON.stringify(op.args)}`);
        calls += 1;
      } else if (op.op === "step") {
        steps(b, op.n);
        if (op.snapshot) {
          assert.deepStrictEqual(b.snapshot(), op.snapshot, where);
          snapshots += 1;
        }
      } else if (op.op === "person") {
        b.setPerson(op.pos);
      } else {
        b.setPressed(op.pin);
      }
      assert.equal(b.stateHash(), op.hash, where);
    });
    assert.ok(calls >= 20 && snapshots >= 5, `${calls} calls, ${snapshots} snapshots`);
  });
}

test("the fixture exercises the rounding ties it claims to", () => {
  const ties = fixture.quantization_ties;
  assert.equal(ties.length, 63);
  const view = new DataView(new ArrayBuffer(8));
  for (const [k, hex] of ties.entries()) {
    view.setBigUint64(0, BigInt(`0x${hex}`));
    const h = view.getFloat64(0);
    assert.equal(h * 63, k + 0.5);
    assert.equal(pyRound(h * 63), k % 2 === 0 ? k : k + 1);
  }
});
