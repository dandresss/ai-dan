// lab/camera.js answers what lab/camera.py answers: the same camera, the same
// screen points, the same pins under the same pointer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as camera from "../lab/camera.js";

const { Camera, height, insideQuad } = camera;
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/camera.json", import.meta.url), "utf8"));
const TOL = 1e-6;   // pixels; Math.cos and C's cos may differ in the last bit

function near(actual, expected, what) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${what}: length`);
    expected.forEach((e, i) => near(actual[i], e, `${what}[${i}]`));
    return;
  }
  if (typeof expected === "number") {
    assert.ok(Math.abs(actual - expected) <= TOL * Math.max(1, Math.abs(expected)), `${what}: ${actual} != ${expected}`);
    return;
  }
  assert.deepEqual(actual, expected, what);
}

const build = (c) => new Camera(c.args[0], c.args[1], c.args[2], c.args[3], c.args[4]);
const where = (c) => `${c.size.join("x")} panel=${c.panel} grid=${c.args[0]}x${c.args[1]}`;

test("the constants are Python's", () => {
  for (const [name, value] of Object.entries(fixtures.constants)) assert.equal(camera[name], value, name);
});

test("the camera is fitted as in Python", () => {
  for (const c of fixtures.cases) {
    const cam = build(c);
    for (const key of ["k", "ox", "oy", "x", "y", "z"]) near(cam[key], c.camera[key], `${key} ${where(c)}`);
    near(cam.bounds(), c.camera.bounds, `bounds ${where(c)}`);
  }
});

test("world points land on the same pixels, and pixels on the same floor points", () => {
  for (const c of fixtures.cases) {
    const cam = build(c);
    for (const [p, px] of c.project) near(cam.project(...p), px, `project ${p} ${where(c)}`);
    for (const [px, pos] of c.floor) near(cam.floor(px), pos, `floor ${px} ${where(c)}`);
  }
});

test("pins are drawn in the same order, with the same faces, on the same plate", () => {
  for (const c of fixtures.cases) {
    const cam = build(c);
    assert.deepEqual(cam.order(), c.order, `order ${where(c)}`);
    near(cam.plate(), c.plate, `plate ${where(c)}`);
    for (const f of c.faces) {
      const got = cam.faces(f.pin[0], f.pin[1], f.h);
      assert.deepEqual(got.map(([kind]) => kind), f.faces.map(([kind]) => kind), `kinds ${f.pin} h=${f.h} ${where(c)}`);
      got.forEach(([, quad], i) => near(quad, f.faces[i][1], `face ${f.pin} h=${f.h} ${where(c)}`));
    }
  }
});

test("the same pin is under the same pointer, held or not", () => {
  for (const c of fixtures.cases) {
    const cam = build(c);
    for (const p of c.pick) {
      const heights = c.patterns[p.heights];
      assert.deepEqual(cam.pick(p.px, heights, p.hold), p.pin, `pick ${p.px} ${p.heights} hold=${JSON.stringify(p.hold)} ${where(c)}`);
    }
  }
});

test("a floor point maps to a pixel and back", () => {
  const cam = build(fixtures.cases[0]);
  for (const [row, col] of [[0, 0], [3.5, 5.25], [9.5, -1], [-2, 4]]) {
    near(cam.floor(cam.project(col, row, 0)), [row, col], `round trip ${row},${col}`);
  }
});

test("heights are read as the drawing reads them", () => {
  assert.equal(height([[0.4]], 0, 0), 0.4);
  assert.equal(height([[1.7]], 0, 0), 1);
  assert.equal(height([[-0.2]], 0, 0), 0);
  assert.equal(height([[null]], 0, 0), 0);
  assert.equal(height([[0.5]], 3, 3), 0);
  assert.equal(height(null, 0, 0), 0);
});

test("a point is inside a quadrilateral either way round, and a flat one holds nothing", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(insideQuad([5, 5], sq), true);
  assert.equal(insideQuad([5, 5], [...sq].reverse()), true);
  assert.equal(insideQuad([10, 5], sq), true);
  assert.equal(insideQuad([11, 5], sq), false);
  assert.equal(insideQuad([5, 0], [[0, 0], [10, 0], [10, 0], [0, 0]]), false);
});
