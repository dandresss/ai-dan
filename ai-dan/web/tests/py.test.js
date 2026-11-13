// lab/py.js against Python's own answers (tests/fixtures/body.json, made by
// make_body_fixtures.py) and against node:crypto for SHA-256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  FLOAT_KEYS, floatRepr, pyDumps, pyEquals, pyLoads, pyMax, pyMin, pyRound, pyRoundN, pyStrip, sha256Hex,
} from "../lab/py.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/body.json", import.meta.url), "utf8"));

const view = new DataView(new ArrayBuffer(8));
function fromHex(hex) {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}
function toHex(x) {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** Run `check` on every case; fail once, listing the first few that differ. */
function expectAll(cases, check) {
  const bad = [];
  for (const c of cases) {
    const problem = check(c);
    if (problem) bad.push(problem);
  }
  assert.equal(bad.length, 0, `${bad.length} of ${cases.length} differ, e.g.\n${bad.slice(0, 8).join("\n")}`);
}

// --- round ---------------------------------------------------------------------
test("pyRound is Python's round(x): ties to even, never -0", () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(-2.5), -2);
  assert.ok(Object.is(pyRound(-0.5), 0));
  assert.ok(Object.is(pyRound(-0.0), 0));
  assert.equal(pyRound(0.49999999999999994), 0);
  assert.equal(pyRound(2 ** 52 - 0.5), 2 ** 52);
  assert.throws(() => pyRound(NaN), RangeError);
  expectAll(fixture.rounds, ([x, want]) => {
    const got = BigInt(pyRound(Number(x))).toString();
    return got === want ? null : `round(${x}): ${got}, Python ${want}`;
  });
});

test("pyRoundN is Python's round(x, n), exactly, signs and ties included", () => {
  assert.equal(pyRoundN(2.25, 1), 2.2);
  assert.equal(pyRoundN(2.35, 1), 2.4);             // 2.35 is a little above 2.35 in binary
  assert.equal(pyRoundN(0.125, 2), 0.12);
  assert.equal(pyRoundN(0.375, 2), 0.38);
  assert.equal(pyRoundN(2.675, 2), 2.67);           // a little below in binary
  assert.equal(pyRoundN(0.5, 0), 0.0);
  assert.equal(pyRoundN(1.5, 0), 2.0);
  assert.ok(Object.is(pyRoundN(-0.001, 2), -0));
  assert.ok(Object.is(pyRoundN(-0.0, 9), -0));
  assert.equal(pyRoundN(1234.5, -2), 1200);
  assert.equal(pyRoundN(Infinity, 2), Infinity);
  const checks = [];
  for (const [x, , all, some] of fixture.rounds) {
    fixture.n_all.forEach((n, i) => checks.push([x, n, all[i]]));
    if (some.length) fixture.n_some.forEach((n, i) => checks.push([x, n, some[i]]));
  }
  expectAll(checks, ([x, n, want]) => {
    const got = pyRoundN(Number(x), n);
    return Object.is(got, Number(want)) ? null : `round(${x}, ${n}): ${floatRepr(got)}, Python ${want}`;
  });
});

// --- repr ------------------------------------------------------------------------
test("floatRepr is Python's repr(float)", () => {
  const cases = [[1, "1.0"], [1e-5, "1e-05"], [1e16, "1e+16"], [1e15, "1000000000000000.0"],
    [0.0001, "0.0001"], [-0, "-0.0"], [0, "0.0"], [5e-324, "5e-324"], [1.5e-7, "1.5e-07"],
    [1e21, "1e+21"], [123.0, "123.0"], [0.1 + 0.2, "0.30000000000000004"], [NaN, "nan"],
    [Infinity, "inf"], [-Infinity, "-inf"], [1.7976931348623157e308, "1.7976931348623157e+308"]];
  for (const [x, want] of cases) assert.equal(floatRepr(x), want);
  const all = [...fixture.rounds.map(([x]) => [Number(x), x]), ...fixture.repr.map(([h, r]) => [fromHex(h), r])];
  expectAll(all, ([x, want]) => (floatRepr(x) === want ? null : `${floatRepr(x)}, Python ${want}`));
});

// --- max, min, strip -------------------------------------------------------------
test("pyMax and pyMin keep the first of equals, as Python does", () => {
  assert.ok(Object.is(pyMax(-0, 0), -0));
  assert.ok(Object.is(pyMax(0, -0), 0));
  assert.ok(Object.is(pyMin(-0, 1), -0));
  assert.ok(Object.is(pyMin(pyMax(-0, 0.0), 1.0), -0));
  assert.equal(pyMax(1, 2), 2);
  assert.equal(pyMin(1, 2), 1);
});

test("pyStrip removes what Python's str.strip removes", () => {
  assert.equal(pyStrip("  hello  "), "hello");
  assert.equal(pyStrip("\x1c hi \x85"), "hi");          // trim() keeps these
  assert.equal(pyStrip("\ufeffhey"), "\ufeffhey");      // trim() removes this
  assert.equal(pyStrip("\u3000a b\u2029\n"), "a b");
  assert.equal(pyStrip(" \t\n "), "");
});

// --- JSON ------------------------------------------------------------------------
test("pyDumps writes Python's json.dumps byte for byte", () => {
  expectAll(fixture.dumps, (line) => {
    const got = pyDumps(JSON.parse(line));
    return got === line ? null : `${got}\n    Python: ${line}`;
  });
});

test("pyDumps: floats under float keys, ints of any size elsewhere", () => {
  assert.equal(pyDumps({ t: 12 }), '{"t": 12.0}');
  assert.equal(pyDumps({ ok: true, t: 0.02 }), '{"ok": true, "t": 0.02}');
  assert.equal(pyDumps({ tick: 3, pos: [4, 9], color: [255, 255, 255] }),
    '{"tick": 3, "pos": [4.0, 9.0], "color": [255, 255, 255]}');
  assert.equal(pyDumps({ n: 1e21, m: 2 ** 70, f: 1e-5 }), '{"n": 1000000000000000000000, "m": 1180591620717411303424, "f": 1e-05}');
  assert.equal(pyDumps({ x: -0 }), '{"x": -0.0}');
  assert.equal(pyDumps([NaN, Infinity, -Infinity]), "[NaN, Infinity, -Infinity]");
  assert.equal(pyDumps({ a: [], b: {}, c: null, d: "é\n\"" }), '{"a": [], "b": {}, "c": null, "d": "é\\n\\""}');
  assert.equal(pyDumps({ a: undefined, b: [undefined] }), '{"b": [null]}');
  assert.equal(pyDumps({ v: 2 }, { floatKeys: new Set(["v"]) }), '{"v": 2.0}');
  assert.ok(FLOAT_KEYS.has("MAX_SESSION_MIN") && !FLOAT_KEYS.has("tick"));
});

test("pyLoads reads the Infinity that json.dumps writes, and nothing else JSON would refuse", () => {
  assert.deepEqual(pyLoads('{"a": 1.5, "b": [true, null]}'), { a: 1.5, b: [true, null] });
  const value = pyLoads('{"x": Infinity, "y": [-Infinity], "s": "Infinity \\" Infinity"}');
  assert.deepEqual(value, { x: Infinity, y: [-Infinity], s: 'Infinity " Infinity' });
  assert.equal(pyLoads(pyDumps({ d: [1e400, -1e400] })).d[1], -Infinity);
  assert.throws(() => pyLoads('{"x": Infinit}'), SyntaxError);
  assert.throws(() => pyLoads("[NaN]"), SyntaxError);   // never written: JSON input cannot hold NaN
});

test("pyEquals is Python's == for JSON values", () => {
  assert.ok(pyEquals({ a: 1, b: [1.0, true] }, { b: [1, 1], a: 1.0 }));
  assert.ok(pyEquals(-0, 0));
  assert.ok(!pyEquals({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!pyEquals([1], { 0: 1 }));
  assert.ok(!pyEquals("1", 1));
  assert.ok(!pyEquals(null, 0));
  assert.ok(!pyEquals(NaN, NaN));
});

// --- SHA-256 -------------------------------------------------------------------------
test("sha256Hex matches node:crypto on every padding boundary and on UTF-8", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const texts = [];
  for (let n = 0; n < 300; n++) texts.push("x".repeat(n));
  texts.push("é 中文 😀", "[1, [[0.0, 0.5]], null]".repeat(500));
  for (const text of texts) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
  }
});

// --- cos -------------------------------------------------------------------------------
// Not a port of anything: a measurement. The nervous system's smooth ease is
// (1 - cos(pi * u)) / 2. Python calls the C library's cos, JavaScript has its
// own (fdlibm in V8). They may differ in the last bit; the state hash rounds
// every float to 9 decimals so that such bits never reach it. This test pins
// down that the two only ever differ by one unit in the last place, and
// reports how often.
test("Math.cos and the C library's cos differ by at most one unit in the last place", (t) => {
  const { n, cos, smooth } = fixture.cos;
  let cosDiffers = 0;
  let smoothDiffers = 0;
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    const want = fromHex(cos.slice(16 * k, 16 * k + 16));
    const got = Math.cos(Math.PI * u);
    if (got !== want) {
      cosDiffers += 1;
      const ulps = Math.abs(Number(BigInt.asIntN(64, BigInt(`0x${toHex(got)}`)) - BigInt.asIntN(64, BigInt(`0x${toHex(want)}`))));
      assert.equal(ulps, 1, `cos(pi * ${u}): ${got} vs ${want}`);
    }
    if (toHex((1 - got) / 2) !== smooth.slice(16 * k, 16 * k + 16)) smoothDiffers += 1;
  }
  t.diagnostic(`cos(pi*u) differs in the last bit for ${cosDiffers} of ${n} values; ` +
    `the smooth ease for ${smoothDiffers} of ${n}`);
});
