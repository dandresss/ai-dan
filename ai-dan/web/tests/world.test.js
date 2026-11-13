// The glue: a port of tests/test_world.py, then the Python lab's own World and
// ReplayWorld runs (fixtures/body.json), every real session log replayed, and
// the JavaScript session the Python suite checks (fixtures/js-session.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { Config } from "../lab/config.js";
import { Feed, SessionLog, parseLog } from "../lab/log.js";
import { pyDumps, pyEquals } from "../lab/py.js";
import { ReplayWorld, World, WorldClosed, verifyLog } from "../lab/world.js";
import { makeJsSession } from "./fixtures/make_js_session.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/body.json", import.meta.url), "utf8"));
const BREATH = { tracks: [{ pins: "all", keyframes: [[0, 0.2], [2, 0.8], [4, 0.2]], loop: true }] };
const yieldToMind = () => new Promise((resolve) => setImmediate(resolve));

/** A short session: a 'mind' awaiting the body, a person who moves and touches. */
async function runSession() {
  const config = new Config();
  const log = new SessionLog();
  log.writeHeader(config, { mind: "none" });
  const world = new World(config, log);
  const body = world.remoteBody();
  const answers = [];
  let ticksSeen = 0;
  const waitTicks = async (n) => { const until = ticksSeen + n; while (ticksSeen < until) await yieldToMind(); };

  let finished = false;
  const mind = (async () => {
    answers.push(await body.call("sense", {}));
    answers.push(await body.call("play", BREATH));
    await waitTicks(3);
    answers.push(await body.call("sense", {}));
    answers.push(await body.call("set_color", { rgb: [255, 120, 40] }));
    answers.push(await body.call("play", { tracks: "nonsense" }));
    await waitTicks(3);
    answers.push(await body.call("sense", {}));
    answers.push(await body.call("stop", { pins: [[0, 0], [7, 7]] }));
  })().then(() => { finished = true; });

  let tail = 300;
  while (!finished || tail > 0) {
    const k = world.body.tick;
    const person = k < 2000 ? [4.0, 9.0 + (k % 50) / 50] : null;
    const pressed = k % 400 >= 120 && k % 400 < 170 ? [3, 3] : null;
    world.tick(person, pressed);
    ticksSeen += 1;
    if (finished) tail -= 1;
    await yieldToMind();
  }
  await mind;
  world.say("hello");
  world.tick(null, null);
  world.close();
  log.close();
  return { world, log, answers };
}

// --- test_world.py ------------------------------------------------------------
test("calls from the mind land on ticks", async () => {
  const { world, log, answers } = await runSession();
  assert.equal(answers.length, 7);
  assert.equal(answers[1].ok, true);
  assert.equal(answers[4].ok, false);
  const calls = parseLog(log.text()).filter((e) => e.type === "call");
  assert.deepEqual(calls.map((c) => c.name), ["sense", "play", "sense", "set_color", "play", "sense", "stop"]);
  assert.ok(calls.every((c) => c.t === c.result.t));
  assert.deepEqual(world.snapshot().color, [255, 120, 40]);
});

test("the world tells the mind about the person", () => {
  const world = new World(new Config());
  world.tick(null, null);
  world.tick([1.0, 2.0], null);
  world.tick([1.0, 2.5], null);
  world.say("  hello  ");
  world.tick(null, null);
  assert.deepEqual(world.events.map((e) => e[0]), ["enter", "voice", "leave"]);
  assert.equal(world.events[1][2], "hello");
});

test("the clock starts when someone arrives", () => {
  const log = new SessionLog();
  const world = new World(new Config(), log);
  for (let k = 0; k < 500; k++) world.tick(null, null);
  assert.ok(world.body.tick === 0 && world.t === 0.0);
  world.tick([4.0, 9.0], null);
  world.tick(null, null);
  world.close();
  log.close();
  assert.deepEqual(parseLog(log.text())[0], { type: "person", tick: 0, t: 0.0, pos: [4.0, 9.0] });
  assert.equal(log.text().split("\n")[0], '{"type": "person", "tick": 0, "t": 0.0, "pos": [4.0, 9.0]}');
  assert.equal(world.body.tick, 2);
});

test("a session replays to the same body states", async () => {
  const { world, log } = await runSession();
  const report = verifyLog(parseLog(log.text()));
  assert.ok(report.ok, report.mismatches.join("\n"));
  assert.equal(report.calls, 7);
  assert.ok(report.states >= 2);
  assert.equal(report.ticks, world.body.tick);
  const replay = new ReplayWorld(parseLog(log.text()));
  while (!replay.done) replay.tick();
  assert.equal(replay.body.stateHash(), world.body.stateHash());
  const kinds = new Set(replay.feed.since(0).map((e) => e.type));
  for (const kind of ["header", "person", "press", "call", "voice"]) assert.ok(kinds.has(kind), kind);
});

test("the replay notices a tampered log", async () => {
  const { log } = await runSession();
  const events = parseLog(log.text());
  const play = events.find((e) => e.type === "call" && e.name === "play" && e.result.ok);
  play.args.tracks[0].keyframes[1][1] = 0.4;
  const report = verifyLog(parseLog(events.map((e) => pyDumps(e)).join("\n")));
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.length > 0);
});

test("a closed world refuses the mind, and releases a call that was waiting", async () => {
  const world = new World(new Config());
  const body = world.remoteBody();
  const waiting = body.call("sense", {});
  world.close();
  await assert.rejects(waiting, WorldClosed);
  await assert.rejects(body.call("sense", {}), (error) => error instanceof WorldClosed && error.name === "WorldClosed");
  assert.equal(world.closed, true);
});

test("a call is answered on the tick that applies it, and logged with the turn", async () => {
  const log = new SessionLog();
  const world = new World(new Config(), log);
  world.tick([4.0, 9.0]);
  world.turn = 7;
  let answer = null;
  const pending = world.remoteBody().call("stop");
  pending.then((r) => { answer = r; });
  await yieldToMind();
  assert.equal(answer, null);                       // nothing happens between ticks
  world.tick([4.0, 9.0]);
  assert.deepEqual(await pending, { ok: true, t: 0.02 });
  const call = parseLog(log.text()).find((e) => e.type === "call");
  assert.deepEqual(call, { type: "call", turn: 7, tick: 1, t: 0.02, name: "stop", args: null, result: { ok: true, t: 0.02 } });
});

test("a model's 1e400 reaches the body as infinity, and the log keeps it as Python does", async () => {
  const log = new SessionLog();
  log.writeHeader(new Config(), { mind: "none" });
  const world = new World(new Config(), log);
  world.tick([4.0, 9.0]);
  const args = JSON.parse('{"tracks": [{"pins": "all", "keyframes": [[0, 0], [1e400, 1]]}]}');
  const answer = world.remoteBody().call("play", args);
  world.tick([4.0, 9.0]);
  assert.equal((await answer).error, "That movement cannot be understood.");
  assert.ok(log.text().includes('"args": {"tracks": [{"pins": "all", "keyframes": [[0, 0], [Infinity, 1]]}]}'));
  assert.equal(world.feed.since(0).find((e) => e.type === "call").args.tracks[0].keyframes[1][0], Infinity);
  world.close();
  assert.ok(verifyLog(parseLog(log.text())).ok);
});

// --- the log --------------------------------------------------------------------
test("SessionLog: Python lines, a JSON-normalised feed, the header, the file name", () => {
  const feed = new Feed();
  const log = new SessionLog({ feed, now: () => new Date(2026, 10, 12, 9, 5, 7) });
  log.writeHeader(new Config(), { t: 0.0, mind: "none" });
  log.write({ type: "voice", tick: 3, t: 0.06, text: "é\n" });
  assert.equal(log.fileName(), "2026-11-12_090507.jsonl");
  const [header, voice] = log.text().split("\n");
  assert.ok(header.startsWith('{"type": "header", "version": 1, "started_at": "2026-11-12T09:05:07", "config": {"GRID_ROWS": 8,'));
  assert.ok(header.endsWith('"STATE_EVERY_TICKS": 250}, "t": 0.0, "mind": "none"}'));
  assert.equal(voice, '{"type": "voice", "tick": 3, "t": 0.06, "text": "é\\n"}');
  assert.ok(log.text().endsWith("\n"));
  assert.equal(feed.length, 2);
  assert.deepEqual(feed.since(1), [{ type: "voice", tick: 3, t: 0.06, text: "é\n" }]);
  log.close();
  log.write({ type: "close", t: 1.0 });                // after close: the feed only, as in Python
  assert.equal(log.text().split("\n").length, 3);
  assert.equal(feed.length, 3);
  assert.deepEqual(parseLog("\r\n  {\"a\": 1}\r\n\n{\"b\": 2}"), [{ a: 1 }, { b: 2 }]);
});

// --- Python's own World and ReplayWorld runs -------------------------------------------
test("World writes exactly the log Python's World writes, from the same script", async () => {
  const recorded = fixture.world;
  const log = new SessionLog();
  const world = new World(new Config(recorded.config), log);
  const body = world.remoteBody();
  const pending = [];
  for (const item of recorded.script) {
    if (item.turn !== null) world.turn = item.turn;
    for (const text of item.voices) world.say(text);
    for (const [name, args] of item.calls) pending.push(body.call(name, structuredClone(args)));
    world.tick(item.person, item.pressed);
  }
  const waiting = body.call("sense", {});
  world.close();
  world.close();
  const afterClose = body.call("sense", {});
  log.close();

  const want = recorded.log.split("\n");
  const got = log.text().split("\n");
  const first = want.findIndex((line, i) => line !== got[i]);
  assert.equal(first, -1, `line ${first + 1} differs:\n  js:     ${got[first]}\n  python: ${want[first]}`);
  assert.equal(log.text(), recorded.log);
  assert.deepEqual(world.events, recorded.events);
  assert.deepEqual((await Promise.all(pending)).map((r) => pyDumps(r)), recorded.results);
  assert.equal(recorded.waiting, "WorldClosed");
  await assert.rejects(waiting, WorldClosed);
  assert.equal(recorded.after_close, "WorldClosed");
  await assert.rejects(afterClose, WorldClosed);
  assert.equal(world.body.tick, recorded.tick);
  assert.equal(world.body.stateHash(), recorded.hash);
});

function replayEvents(name) {
  const events = parseLog(fixture.world.log);
  if (name === "tampered") {
    const play = events.find((e) => e.type === "call" && e.name === "play" && e.result.ok);
    play.args.tracks[0].keyframes[1][1] = 0.4;
  }
  if (name === "wrong_result") events.find((e) => e.type === "call" && e.name === "sense").result.t = 99.0;
  const { header, story } = structuredClone(fixture.replays);
  return { world: [header, ...events], story: [header, ...events, ...story], tampered: [header, ...events],
    wrong_result: [header, ...events], header_only: [header], story_only: [header, ...story] }[name];
}

for (const recorded of fixture.replays.cases) {
  test(`ReplayWorld runs Python's crafted log "${recorded.name}" tick for tick`, () => {
    const replay = new ReplayWorld(replayEvents(recorded.name));
    assert.equal(replay.endTick, recorded.end_tick);
    const trace = [];
    while (!replay.done) {
      replay.tick();
      trace.push(replay.feed.length);
    }
    assert.deepEqual(trace, recorded.feed_lengths);
    assert.equal(replay.callsReplayed, recorded.calls);
    assert.equal(replay.statesChecked, recorded.states);
    assert.deepEqual(replay.mismatches, recorded.mismatches);
    assert.equal(replay.body.tick, recorded.tick);
    assert.equal(replay.body.stateHash(), recorded.hash);
  });
}

test("ReplayWorld refuses a file with no header", () => {
  assert.throws(() => new ReplayWorld([{ type: "person", tick: 0, t: 0.0, pos: null }]), /no header/);
});

// --- every real session ------------------------------------------------------------------
function sessionLogs() {
  const files = [];
  for (const dir of ["../../docs/", "../../sessions/"]) {
    const url = new URL(dir, import.meta.url);
    if (!existsSync(url)) continue;                // ../sessions is git-ignored
    for (const name of readdirSync(url).sort()) if (name.endsWith(".jsonl")) files.push(new URL(name, url));
  }
  files.push(new URL("../sessions/first-wake.jsonl", import.meta.url));
  return files;
}

test("every real session log replays to the same results and body states", (t) => {
  let states = 0;
  let calls = 0;
  for (const file of sessionLogs()) {
    const events = parseLog(readFileSync(file, "utf8"));
    const report = verifyLog(events);
    const bodyCalls = events.filter((e) => e.type === "call" && Object.hasOwn(e, "tick")).length;
    assert.ok(report.ok, `${file.pathname}: ${report.mismatches.join("; ")}`);
    assert.ok(report.states > 0, file.pathname);
    assert.equal(report.calls, bodyCalls, file.pathname);
    states += report.states;
    calls += report.calls;
    t.diagnostic(`${file.pathname.split("/").slice(-3).join("/")}: ${report.ticks} ticks, ` +
      `${report.calls} calls, ${report.states} states, ok`);
  }
  t.diagnostic(`total: ${calls} calls replayed, ${states} states checked, 0 mismatches`);
});

// Inside the `args` of a call is the model's raw input: Python keeps the
// model's own spelling (2 or 2.0), which a JavaScript number cannot. Those
// are compared by value; everything else on the line byte for byte.
function compareLine(line) {
  const event = JSON.parse(line);
  if (pyDumps(event) === line) return "exact";
  if (event.type !== "call" || !Object.hasOwn(event, "args")) return "differs";
  const marker = "\u0000args\u0000";
  const [before, after] = pyDumps({ ...event, args: marker }).split(JSON.stringify(marker));
  if (!line.startsWith(before) || !line.endsWith(after)) return "differs";
  const args = JSON.parse(line.slice(before.length, line.length - after.length));
  return pyEquals(args, event.args) ? "args by value" : "differs";
}

test("pyDumps rewrites every line of every real session byte for byte", (t) => {
  const counts = { exact: 0, "args by value": 0, differs: 0 };
  const bad = [];
  for (const file of sessionLogs()) {
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const verdict = compareLine(line);
      counts[verdict] += 1;
      if (verdict === "differs") bad.push(line.slice(0, 200));
    }
  }
  t.diagnostic(`${counts.exact} lines byte-identical, ${counts["args by value"]} equal with args by value`);
  assert.deepEqual(bad, []);
  assert.ok(counts.exact > 1000);
});

// --- the other direction -----------------------------------------------------------------------
test("the JavaScript session for the Python suite is current and replays here too", async () => {
  const file = new URL("./fixtures/js-session.jsonl", import.meta.url);
  const text = await makeJsSession();
  assert.equal(readFileSync(file, "utf8"), text, "run: node tests/fixtures/make_js_session.js");
  const report = verifyLog(parseLog(text));
  assert.ok(report.ok, report.mismatches.join("\n"));
  assert.ok(report.calls > 10 && report.states > 1);
});
