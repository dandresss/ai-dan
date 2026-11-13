// The mind loop, driven step by step with a clock the test controls.
// Port of tests/test_harness.py.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Config } from "../lab/config.js";
import { Harness } from "../lab/harness.js";
import { ModelError } from "../lab/model.js";
import { NOTE_KEY } from "../lab/mind.js";
import { FakeModel, FakeWorld, response, say, think, use } from "./harness_fakes.js";

const round2 = (x) => Math.round(x * 100) / 100;

function memoryStore(initial = null) {
  const items = new Map(initial === null ? [] : [[NOTE_KEY, initial]]);
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
}

function make(script = [], { config = new Config(), onCall = null, noteStore = null } = {}) {
  const world = new FakeWorld();
  const model = new FakeModel(script, { onCall });
  const waits = [];
  const h = new Harness(world, model, config, { noteStore, sleep: async (s) => { waits.push(s); } });
  h.start({ runLoop: false });
  return { world, model, h, waits };
}

// Step the harness while the clock runs to `until`. Returns turns run.
async function advance(world, h, until, dt = 0.5) {
  let turns = 0;
  while (world.t < until) {
    turns += (await h.step()) ? 1 : 0;
    world.t = round2(world.t + dt);
  }
  return turns;
}

const reasonsOf = (world) => world.logged("wake").map((w) => w.reasons);
const sensePayloads = (messages) =>
  messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").map((b) => b.content);

// --- session start ---------------------------------------------------------------

test("header first and nothing sent before arrival", async () => {   // harness.md criterion 1
  const { world, model, h } = make();
  assert.equal(world.logged()[0].type, "header");
  world.say("is anyone there");   // a line typed before the mouse ever entered
  await advance(world, h, 60);
  assert.deepEqual(model.sent, []);
  assert.equal(h.startedAt, null);

  world.enter();
  await h.step();
  assert.equal(model.sent.length, 1);
  const wake = world.logged("wake")[0];
  assert.deepEqual(wake.reasons, ["voice", "arrival"]);
  assert.equal(wake.message, '{"t": 60.0, "heard": ["is anyone there"]}');
});

test("the header records the prompt actually sent", async () => {   // mind.md criterion 1
  const { world, model, h } = make();
  world.enter();
  await h.step();
  const header = world.logged("header")[0];
  assert.equal(header.prompt, model.systems[0]);
  assert.equal(header.prompt_version, "mind-v0");
  assert.deepEqual(header.tools, model.tools[0].map((t) => t.name));
  assert.equal(header.model, "fake");
  assert.equal(header.mind, "live");
  assert.equal(header.memory_enabled, false);
  assert.equal(header.config.PULSE_S, 12);
});

test("the wake message is bare", async () => {
  const { world, model, h } = make();
  world.enter();
  await h.step();
  assert.deepEqual(model.sent[0].at(-1).content, [{ type: "text", text: '{"t": 0.0}' }]);
  world.t = 31.5;
  world.say("hello");
  await h.step();
  assert.equal(model.sent[1].at(-1).content.at(-1).text, '{"t": 31.5, "heard": ["hello"]}');
});

test("log lines are written exactly as Python writes them", async () => {
  const { world, h } = make([response(think("hm"), say("hi"))]);
  world.enter();
  await h.step();
  await h.stop();
  const lines = world.log.lines;
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).slice(3),
    ["config", "t", "prompt_version", "prompt", "model", "tools", "memory_enabled", "mind"]);
  assert.deepEqual(lines.slice(1), [
    '{"type": "wake", "t": 0.0, "turn": 1, "reasons": ["arrival"], "message": "{\\"t\\": 0.0}"}',
    '{"type": "usage", "t": 0.0, "turn": 1, "model": "fake", "stop_reason": "end_turn", "input_tokens": 10, "output_tokens": 5}',
    '{"type": "thought", "t": 0.0, "turn": 1, "kind": "thinking", "text": "hm"}',
    '{"type": "thought", "t": 0.0, "turn": 1, "kind": "text", "text": "hi"}',
    '{"type": "turn_end", "t": 0.0, "turn": 1, "tool_calls": 0, "capped": false, "skipped": false}',
    '{"type": "close", "t": 0.0, "reason": "window_closed", "turns": 1, "input_tokens": 10, "output_tokens": 5}',
  ]);
});

test("a tool result is the bytes Python would send", async () => {
  const { world, model, h } = make([response(use("sense")), response(use("play", { tracks: [] }))]);
  world.enter();
  await h.step();
  const results = sensePayloads(model.sent[1]);
  assert.equal(results[0], '{"t": 0.0, "actual": [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], ' +
    Array(7).fill("[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]").join(", ") +
    '], "gap": [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], ' +
    Array(7).fill("[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]").join(", ") +
    '], "person": null, "color": [255, 255, 255]}');
  assert.equal(sensePayloads(model.sent[2])[1], '{"ok": true, "t": 0.0}');
});

// --- wakes ---------------------------------------------------------------------------

test("pulse only while present, and one farewell", async () => {   // harness.md criterion 3
  const { world, h } = make();
  world.enter();
  await advance(world, h, 60);
  const wakes = world.logged("wake");
  assert.deepEqual(reasonsOf(world), [["arrival"], ["pulse"], ["pulse"], ["pulse"], ["pulse"]]);
  assert.deepEqual(wakes.map((w) => w.t), [0, 12, 24, 36, 48]);

  world.leave();
  await advance(world, h, 200);
  const after = world.logged("wake").slice(wakes.length);
  assert.deepEqual(after.map((w) => w.reasons), [["departure"]]);
  assert.equal(after[0].t, 62);   // left at 60, gone after the 2 s grace

  world.enter();
  await advance(world, h, 213);
  const back = world.logged("wake").slice(wakes.length + 1);
  assert.deepEqual(back.map((w) => w.reasons), [["arrival"], ["pulse"]]);
});

test("leaving and returning within the grace is not an event", async () => {
  const { world, h } = make();
  world.enter();
  await advance(world, h, 5);
  world.leave();
  await advance(world, h, 6.5);
  world.enter();
  await advance(world, h, 30);
  assert.deepEqual(reasonsOf(world), [["arrival"], ["pulse"], ["pulse"]]);
});

test("the pulse counts from the end of the turn", async () => {
  const world = new FakeWorld();
  const model = new FakeModel([], { onCall: () => { world.t = round2(world.t + 5); } });   // 5 s per model call
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  await advance(world, h, 40);
  assert.deepEqual(world.logged("wake").map((w) => w.t), [0, 17, 34]);
});

test("a voice wakes even without a pulse, and touch does not", async () => {
  const { world, h } = make();
  world.enter();
  await h.step();
  world.t = 3;
  world.say("hi");
  await h.step();
  assert.deepEqual(reasonsOf(world), [["arrival"], ["voice"]]);
});

test("lines typed during a turn reach the next wake", async () => {   // harness.md criterion 5
  const world = new FakeWorld();
  const during = (n) => {
    if (n === 1) {
      world.say("hello");
      world.say("are you there");
      world.leave();
      world.enter();   // back within the grace: no event
    }
  };
  const model = new FakeModel([response(use("sense")), response(say("still"))], { onCall: during });
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  await h.step();
  world.t = 1;
  assert.ok(await h.step());
  const wake = world.logged("wake")[1];
  assert.deepEqual(wake.reasons, ["voice"]);
  assert.deepEqual(JSON.parse(wake.message), { t: 1, heard: ["hello", "are you there"] });
  assert.ok(!(await h.step()));
});

// --- session end ----------------------------------------------------------------------

test("the session ends at max turns", async () => {   // harness.md criterion 7
  const { world, h } = make();
  world.enter();
  await advance(world, h, 2000, 1);
  assert.equal(h.turn, 40);
  assert.equal(world.logged("wake").length, 40);
  const close = world.logged("close");
  assert.equal(close.length, 1);
  assert.equal(close[0].reason, "max_turns");
  assert.equal(close[0].turns, 40);
  assert.equal(close[0].input_tokens, 400);
  assert.equal(close[0].output_tokens, 200);
  assert.equal(world.logged().at(-1).type, "close");
});

test("the session ends at max minutes after the first arrival", async () => {   // harness.md criterion 7
  const { world, model, h } = make();
  world.t = 100;
  world.enter();
  await h.step();
  world.leave();
  await advance(world, h, 999.5);
  assert.deepEqual(world.logged("close"), []);
  await advance(world, h, 1000.5);
  const close = world.logged("close");
  assert.equal(close[0].reason, "max_minutes");
  assert.equal(close[0].t, 1000);
  const calls = model.sent.length;
  world.enter();
  world.say("hello?");
  await advance(world, h, 1100);
  assert.equal(model.sent.length, calls);   // never woken again
  assert.deepEqual(world.body.calls, []);   // and the body is left alone
});

test("session time runs out mid-turn", async () => {
  const world = new FakeWorld();
  const model = new FakeModel(Array.from({ length: 5 }, () => response(use("sense"))),
                              { onCall: () => { world.t = round2(world.t + 400); } });
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 3);          // answered at 400, 800, 1200
  assert.equal(world.body.calls.length, 2);    // the calls answered at 1200 are not run
  assert.deepEqual(world.logged().slice(-2).map((e) => e.type), ["turn_end", "close"]);
  assert.equal(world.logged("close")[0].reason, "max_minutes");
});

test("stop is idempotent and writes one close", async () => {
  const { world, h } = make();
  world.enter();
  await h.step();
  await h.stop();
  await h.stop("max_turns");
  const close = world.logged("close");
  assert.equal(close.length, 1);
  assert.equal(close[0].reason, "window_closed");
  assert.equal(close[0].turns, 1);
  world.say("hello");
  assert.ok(!(await h.step()));
});

test("the loop runs turns and stops", async () => {
  const world = new FakeWorld();
  const model = new FakeModel();
  const h = new Harness(world, model, new Config());
  h.start();
  world.enter();
  const deadline = Date.now() + 5000;
  while (!world.logged("turn_end").length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await h.stop();
  assert.equal(model.sent.length, 1);
  await h._loop;   // the loop has returned
  assert.equal(world.logged().at(-1).type, "close");
});

test("stop cancels a request in flight and discards what comes after", async () => {
  const world = new FakeWorld();
  let release;
  const model = new FakeModel();
  model.abortCalls = 0;
  model.abort = () => { model.abortCalls += 1; release(new Error("cancelled")); };
  model.respond = () => new Promise((resolve, reject) => { release = reject; });
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  const turn = h.step();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.stop();
  await turn;
  assert.equal(model.abortCalls, 1);
  assert.deepEqual(world.logged("api_error"), []);   // a cancellation is not an API error
  assert.deepEqual(world.logged().slice(-2).map((e) => e.type), ["turn_end", "close"]);
  assert.equal(world.logged("turn_end")[0].skipped, false);
});

test("an answer arriving after stop is discarded", async () => {
  const world = new FakeWorld();
  let answer;
  const model = new FakeModel();
  model.respond = () => new Promise((resolve) => { answer = resolve; });   // cannot be cancelled
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  const turn = h.step();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = h.stop();
  await stopping;   // gives the turn its second, then closes
  answer(response(say("too late"), use("sense")));
  await turn;
  assert.equal(world.logged("close").length, 1);
  assert.equal(world.logged().at(-1).type, "close");
  assert.deepEqual(world.body.calls, []);
});

// --- the turn --------------------------------------------------------------------------

test("a turn runs calls in order and logs everything", async () => {
  const script = [
    response(think("what is this"), say("let me feel"), use("sense")),
    response(think(""), use("play", { tracks: [] }), use("set_color", { rgb: [1, 2, 3] })),
    response(say("enough")),
  ];
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  assert.deepEqual(world.body.calls.map((c) => c[0]), ["sense", "play", "set_color"]);
  assert.equal(model.sent.length, 3);
  assert.deepEqual(world.logged("thought").map((e) => [e.kind, e.text]),
    [["thinking", "what is this"], ["text", "let me feel"], ["text", "enough"]]);
  assert.deepEqual(world.logged("usage").map((e) => e.stop_reason), ["tool_use", "tool_use", "end_turn"]);
  assert.ok(world.logged("call").every((e) => e.turn === 1));
  assert.deepEqual(world.logged("turn_end")[0],
    { type: "turn_end", t: 0, turn: 1, tool_calls: 3, capped: false, skipped: false });
  const order = world.logged().map((e) => e.type).filter((k) => k !== "header");
  assert.deepEqual(order, ["wake", "usage", "thought", "thought", "call", "usage", "call", "call",
                           "usage", "thought", "turn_end"]);
});

test("a turn stops at eight calls", async () => {   // harness.md criterion 4
  const script = Array.from({ length: 5 }, () => response(use("sense"), use("sense"), use("sense")));
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 3);   // 3 + 3 + 3 calls asked, 8 run
  assert.equal(world.body.calls.length, 8);
  const end = world.logged("turn_end")[0];
  assert.equal(end.tool_calls, 8);
  assert.equal(end.capped, true);
  const past = world.logged("call").filter((e) => !("tick" in e));
  assert.equal(past.length, 1);
  assert.deepEqual(past[0].result, { ok: false, t: 0, error: "That is too much for one moment." });

  // The results of the last response travel with the next wake, before its text.
  world.t = 12;
  await h.step();
  const next = model.sent[3].at(-1).content;
  assert.deepEqual(next.map((b) => b.type), ["tool_result", "tool_result", "tool_result", "text"]);
  assert.equal(JSON.parse(next[2].content).error, "That is too much for one moment.");
  assert.equal(next[3].text, '{"t": 12.0}');
});

test("one response with more calls than the cap", async () => {
  const { world, model, h } = make([response(...Array.from({ length: 11 }, () => use("stop")))]);
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 1);
  assert.equal(world.body.calls.length, 8);
  assert.equal(world.logged("call").filter((e) => !("tick" in e)).length, 3);
});

test("API failures are retried with growing waits", async () => {
  const script = [new ModelError("overloaded", true), new ModelError("connection", true),
                  response(say("there"))];
  const { world, h, waits } = make(script);
  world.enter();
  await h.step();
  assert.deepEqual(world.logged("api_error").map((e) => [e.attempt, e.error]),
    [[1, "overloaded"], [2, "connection"]]);
  assert.deepEqual(waits, [2, 4]);
  assert.equal(world.logged("turn_end")[0].skipped, false);
});

test("a persistent failure skips the turn", async () => {
  const { world, model, h, waits } = make(Array.from({ length: 10 }, () => new ModelError("down", true)));
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 4);   // the first try and three retries
  assert.deepEqual(waits, [2, 4, 8]);
  assert.equal(world.logged("turn_end")[0].skipped, true);
  assert.deepEqual(world.body.calls, []);
});

test("client errors are not retried", async () => {
  const { world, model, h, waits } = make([new ModelError("HTTP 400: bad", false)]);
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(world.logged("turn_end")[0].skipped, true);
});

test("an unexpected exception is logged and not retried", async () => {
  const { world, model, h } = make([new TypeError("nope")]);
  world.enter();
  await h.step();
  assert.equal(model.sent.length, 1);
  assert.equal(world.logged("api_error")[0].error, "TypeError: nope");
  assert.equal(world.logged("turn_end")[0].skipped, true);
});

test("a failure halfway through a turn leaves a valid conversation", async () => {
  const script = [response(think("hm"), use("sense")),
                  new ModelError("bad", false),
                  response(say("again"), use("sense")),
                  response(say("ok"))];
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  world.t = 12;
  await h.step();   // FakeModel checks validity on every call
  const last = model.sent.at(-1);
  assert.deepEqual(last.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(last[1].content[0], { type: "text", text: "hm" });   // settled thinking
  // The next wake joined the message that was still waiting for an answer.
  assert.deepEqual(last[2].content.map((b) => b.type), ["tool_result", "text"]);
  assert.equal(last[2].content[1].text, '{"t": 12.0}');
});

test("a refusal is logged and the turn skipped", async () => {
  const script = [response(use("sense")), response(say("no"), { stop: "refusal" }), response(say("fine"))];
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  assert.equal(world.logged("usage").at(-1).stop_reason, "refusal");
  assert.equal(world.logged("turn_end")[0].skipped, true);
  world.t = 12;
  await h.step();
  assert.ok(model.sent.at(-1).every((m) => m.content.every((b) => b.text !== "no")));
});

test("a response cut off at the output cap never reaches the body", async () => {
  // A call cut off mid-way can still parse as a smaller, valid movement.
  const script = [response(say("half"), use("play", { tracks: [{ pins: "all" }] }), { stop: "max_tokens" }),
                  response(say("done"))];
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  assert.deepEqual(world.body.calls, []);
  assert.equal(model.sent.length, 1);   // the turn ends there
  const refused = world.logged("call")[0];
  assert.ok(!("tick" in refused));
  assert.equal(refused.result.ok, false);
  assert.equal(world.logged("turn_end")[0].capped, true);
  world.t = 12;
  await h.step();   // its answer travels with the next wake
  assert.deepEqual(model.sent[1].at(-1).content.map((b) => b.type), ["tool_result", "text"]);
});

test("leaving and returning during a turn is not lost", async () => {   // harness.md criterion 3
  const world = new FakeWorld();
  const away = (n) => {
    if (n === 1) {   // while the model is thinking in turn 1
      world.t = 5;
      world.leave();
      world.t = 25;   // gone for 20 s, far past the grace
      world.enter();
      world.t = 26;
    }
  };
  const model = new FakeModel([], { onCall: away });
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  await h.step();
  await h.step();
  assert.deepEqual(reasonsOf(world), [["arrival"], ["departure", "arrival"]]);
  await advance(world, h, 60);   // present again: the pulse carries on
  assert.deepEqual(reasonsOf(world).slice(2), [["pulse"], ["pulse"]]);
});

test("stepping out briefly during a turn is still not an event", async () => {
  const world = new FakeWorld();
  const away = (n) => {
    if (n === 1) {
      world.t = 5;
      world.leave();
      world.t = 6;   // back within the 2 s grace
      world.enter();
    }
  };
  const model = new FakeModel([], { onCall: away });
  const h = new Harness(world, model, new Config());
  h.start({ runLoop: false });
  world.enter();
  await h.step();
  assert.ok(!(await h.step()));
  assert.deepEqual(reasonsOf(world), [["arrival"]]);
});

test("the world closing mid-turn ends the session", async () => {
  const { world, model, h } = make([response(use("sense"), use("sense"))]);
  world.closeOnCall = true;
  world.enter();
  await h.step();
  assert.deepEqual(world.logged().slice(-2).map((e) => e.type), ["turn_end", "close"]);
  assert.equal(world.logged("close")[0].reason, "window_closed");
  world.closeOnCall = false;
  world.say("hello");
  assert.ok(!(await h.step()));
  assert.equal(model.sent.length, 1);
});

test("only an empty thinking block leaves no empty message", async () => {
  const { world, model, h } = make([response(think("")), response(say(" "), use("sense")), response(think("", "s2"))]);
  world.enter();
  await h.step();
  world.t = 12;
  await h.step();
  world.t = 24;
  await h.step();
  assert.deepEqual(world.logged("thought").filter((e) => e.turn < 3), []);
  // unanswered wakes joined, roles alternate
  assert.deepEqual(model.sent.at(-1).map((m) => m.role), ["user", "assistant", "user"]);
});

// --- memory within the session ----------------------------------------------------------

test("thinking is unchanged within the turn and text after", async () => {
  const script = [response(think("first idea", "sig-a"), say("hm"), use("sense")),
                  response(think("second", "sig-b"), say("ok"))];
  const { world, model, h } = make(script);
  world.enter();
  await h.step();
  assert.deepEqual(model.sent[1][1].content[0], { type: "thinking", thinking: "first idea", signature: "sig-a" });
  world.t = 12;
  await h.step();
  const history = model.sent[2];
  assert.deepEqual(history[1].content, [say("first idea"), say("hm"), history[1].content[2]]);
  assert.deepEqual(history[3].content, [say("second"), say("ok")]);
});

test("old sense results fade, and text and calls stay", async () => {
  let script = [];
  for (let n = 1; n <= 9; n++) script.push(response(say(`turn ${n}`), use("sense")), response(say(`end ${n}`)));
  const { world, model, h } = make(script);
  world.enter();
  for (let n = 0; n < 9; n++) {
    world.t = 12 * n;
    await h.step();
  }
  // First request of turn 8: turns 2..7 (the last six) in full, turn 1 faded.
  const turn8 = model.sent[14];
  let results = sensePayloads(turn8);
  assert.equal(results[0], '{"t": 0.0, "faded": true}');
  assert.ok(results.slice(1).every((r) => r.includes('"actual"')));
  // Within turn 8 the history does not change between calls.
  assert.deepEqual(model.sent[15].slice(0, turn8.length), turn8);
  // Turn 9: turns 1 and 2 faded.
  results = sensePayloads(model.sent[16]);
  assert.deepEqual(results.slice(0, 2), ['{"t": 0.0, "faded": true}', '{"t": 12.0, "faded": true}']);
  assert.ok(results.slice(2).every((r) => r.includes('"actual"')));
  // The agent's words and calls are all still there.
  const blocks = model.sent[16].flatMap((m) => m.content);
  const words = blocks.filter((b) => b.type === "text").map((b) => b.text);
  assert.ok(words.includes("turn 1") && words.includes("end 1"));
  assert.equal(blocks.filter((b) => b.type === "tool_use").length, 8);
});

test("MEMORY_FULL_TURNS of zero keeps only the current turn", async () => {
  const script = [response(use("sense")), response(say("a")), response(use("sense")), response(say("b"))];
  const { world, model, h } = make(script, { config: new Config({ MEMORY_FULL_TURNS: 0 }) });
  world.enter();
  await h.step();
  world.t = 12;
  await h.step();
  const results = sensePayloads(model.sent[3]);
  assert.equal(results[0], '{"t": 0.0, "faded": true}');
  assert.ok(results[1].includes('"actual"'));
});

// --- remember ---------------------------------------------------------------------------

test("remember counts toward the cap and is logged without a tick", async () => {
  const store = memoryStore();
  const script = [response(use("remember", { text: "flat at first" }),
                           ...Array.from({ length: 8 }, () => use("sense")))];
  const { world, h } = make(script, { config: new Config({ MEMORY_ENABLED: true }), noteStore: store });
  world.enter();
  await h.step();
  assert.equal(store.getItem(NOTE_KEY), "flat at first");
  assert.equal(world.body.calls.length, 7);
  const remembered = world.logged("call").find((e) => e.name === "remember");
  assert.ok(!("tick" in remembered));
  assert.deepEqual(remembered.result, { ok: true, t: 0 });
});

test("remember does not exist in first-day mode", async () => {
  const store = memoryStore("old");
  const { world, h } = make([response(use("remember", { text: "new" }))], { noteStore: store });
  world.enter();
  await h.step();
  assert.equal(store.getItem(NOTE_KEY), "old");
  assert.deepEqual(world.body.calls, [["remember", { text: "new" }]]);   // the body answers it as unknown
});

test("memory mode works without a store: the note lives for the session", async () => {
  const { world, h } = make([response(use("remember", { text: "x" }))], { config: new Config({ MEMORY_ENABLED: true }) });
  world.enter();
  await h.step();
  assert.deepEqual(world.logged("call")[0].result, { ok: true, t: 0 });
});
