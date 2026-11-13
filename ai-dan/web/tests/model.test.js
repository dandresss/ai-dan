// The model client (without the network) and the wiring-test pattern.
// Port of tests/test_model.py; the SDK exception classes become HTTP statuses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Config } from "../lab/config.js";
import { Harness } from "../lab/harness.js";
import { AnthropicModel, ModelError, ScriptedModel, requestBody } from "../lab/model.js";
import { thinkingParam, toolDefinitions } from "../lab/mind.js";
import { FakeWorld, assertValid } from "./harness_fakes.js";

const KEY = "sk-ant-test-key-1234";

// A fetch that records what it was sent and answers with `reply`.
function fakeFetch(reply) {
  const fake = async (url, init) => {
    fake.calls.push({ url, init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(init) : reply;
  };
  fake.calls = [];
  return fake;
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const apiError = (status, message) => json(status, { type: "error", error: { type: "x", message } });

const message = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content: [{ type: "thinking", thinking: "hm", signature: "sig" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "toolu_1", name: "sense", input: {} }],
  stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
};

const direct = (fetch, options = {}) => new AnthropicModel(new Config(), { apiKey: KEY }, { fetch, ...options });
const ask = (model) => model.respond("sys", [{ name: "sense" }], [{ role: "user", content: "x" }]);

// --- errors are sorted for retry -----------------------------------------------------

const statuses = [
  [429, true], [500, true], [529, true], [408, true], [409, true],
  [400, false], [401, false], [403, false], [404, false],
];
for (const [status, retryable] of statuses) {
  test(`HTTP ${status} is ${retryable ? "" : "not "}retryable`, async () => {
    const model = direct(fakeFetch(apiError(status, "boom")));
    await assert.rejects(ask(model), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.retryable, retryable);
      assert.ok(error.message.includes(`${status}`) && error.message.includes("boom"));
      return true;
    });
  });
}

test("a network failure is retryable", async () => {
  const model = direct(fakeFetch(new TypeError("Failed to fetch")));
  await assert.rejects(ask(model), (error) => error instanceof ModelError && error.retryable === true);
});

test("a timeout is not retryable: it would only hang the turn again", async () => {
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const model = direct(fakeFetch(hang), { timeoutMs: 20 });
  await assert.rejects(ask(model), (error) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /^Timeout/);
    return true;
  });
});

test("the timeout is 120 seconds by default", async () => {
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); };
  try {
    await ask(direct(fakeFetch(json(200, message))));
  } finally {
    globalThis.setTimeout = real;
  }
  assert.ok(delays.includes(120000));
});

test("abort() cancels the request in flight, not retryable", async () => {
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const model = direct(fakeFetch(hang));
  const pending = ask(model);
  await new Promise((resolve) => setTimeout(resolve, 5));
  model.abort();
  await assert.rejects(pending, (error) => error instanceof ModelError && !error.retryable
    && /^Cancelled/.test(error.message));
  model.abort();   // nothing in flight: harmless
});

test("an answer that is not JSON is an error, not a crash", async () => {
  await assert.rejects(ask(direct(fakeFetch(json(200, "<html>")))),
    (error) => error instanceof ModelError && !error.retryable);
});

test("a non-JSON error body keeps its text", async () => {
  await assert.rejects(ask(direct(fakeFetch(json(502, "Bad Gateway")))),
    (error) => error.retryable && error.message.includes("Bad Gateway"));
});

test("the key never appears in an error", async () => {
  for (const reply of [apiError(401, `invalid x-api-key ${KEY}`), new TypeError(`bad ${KEY}`)]) {
    await assert.rejects(ask(direct(fakeFetch(reply))), (error) => {
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  }
});

// --- the request ---------------------------------------------------------------------

test("the thinking setting", () => {
  assert.deepEqual(thinkingParam(new Config()), { type: "adaptive", display: "summarized" });
  assert.deepEqual(thinkingParam(new Config({ THINKING: "between_tools" })), { type: "between_tools" });
});

test("request shape and response", async () => {
  const fetch = fakeFetch(json(200, message));
  const result = await ask(direct(fetch));
  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  });
  assert.deepEqual(body, {
    model: "claude-sonnet-5-5", max_tokens: 4096, system: "sys",
    tools: [{ name: "sense" }], messages: [{ role: "user", content: "x" }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
  });
  assert.deepEqual(Object.keys(body),
    ["model", "max_tokens", "system", "tools", "messages", "thinking", "output_config"]);
  assert.deepEqual(result, {
    content: message.content, stop_reason: "tool_use", model: "claude-sonnet-5-5",
    input_tokens: 120, output_tokens: 30,
  });
});

test("requestBody follows the config", () => {
  const body = requestBody(new Config({ EFFORT: "high", THINKING: "between_tools", MAX_TOKENS: 100 }),
    "s", toolDefinitions(new Config()), []);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.deepEqual(body.thinking, { type: "between_tools" });
});

test("through the host: the access code, never a key", async () => {
  const fetch = fakeFetch(json(200, message));
  const model = new AnthropicModel(new Config(), { accessCode: "open sesame" }, { fetch });
  const result = await ask(model);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "/api/mind");
  assert.deepEqual(init.headers, { "content-type": "application/json", "x-lab-access-code": "open sesame" });
  assert.deepEqual(body, requestBody(new Config(), "sys", [{ name: "sense" }], [{ role: "user", content: "x" }]));
  assert.equal(result.output_tokens, 30);

  const other = new AnthropicModel(new Config(), { accessCode: "a", endpoint: "/elsewhere" }, { fetch });
  await ask(other);
  assert.equal(fetch.calls[1].url, "/elsewhere");
});

test("a refused access code is an error the harness will not retry", async () => {
  const model = new AnthropicModel(new Config(), { accessCode: "wrong" },
    { fetch: fakeFetch(apiError(401, "Wrong access code")) });
  await assert.rejects(ask(model), (error) => !error.retryable && error.message.includes("Wrong access code"));
});

test("the model's name is the configured model", () => {
  assert.equal(direct(fakeFetch(json(200, message))).name, "claude-sonnet-5-5");
});

// --- the wiring test ---------------------------------------------------------------------

test("the scripted model is a mechanical test pattern", async () => {
  const world = new FakeWorld();
  const scripted = new ScriptedModel(new Config());
  const recording = {
    name: scripted.name,
    async respond(system, tools, messages) {
      assertValid(messages);
      return scripted.respond(system, tools, messages);
    },
  };
  const h = new Harness(world, recording, new Config());
  h.start({ runLoop: false });
  world.enter();
  for (let n = 0; n < 7; n++) {
    world.t = 12 * n;
    assert.ok(await h.step());
  }

  assert.equal(world.logged("header")[0].mind, "scripted");
  const names = world.body.calls.map((c) => c[0]);
  for (const name of ["sense", "play", "stop", "set_color"]) assert.ok(names.includes(name), name);
  assert.equal(world.logged("wake")[6].turn, 7);
  assert.equal(names.at(-1), "sense");   // the cycle repeats
  const thoughts = world.logged("thought").map((e) => e.text);
  assert.ok(thoughts.length && thoughts.every((t) => t.startsWith("wiring test: step ")));
  assert.ok(world.logged("turn_end").every((e) => !e.capped && !e.skipped));

  const plays = world.body.calls.filter((c) => c[0] === "play").map((c) => c[1]);
  const invalid = plays.at(-1).tracks[0].pins[0];
  assert.ok(invalid[0] >= 8 && invalid[1] >= 8);   // outside the grid on purpose
  // Nothing in the pattern could pass for breathing: only one pin ever loops.
  const looping = plays.flatMap((args) => args.tracks).filter((t) => t.loop);
  assert.equal(looping.reduce((n, t) => n + t.pins.length, 0), 1);
});

test("the scripted model's ids and labels", async () => {
  const scripted = new ScriptedModel(new Config());
  const wake = [{ role: "user", content: [{ type: "text", text: '{"t": 0.0}' }] }];
  const first = await scripted.respond("", [], wake);
  assert.deepEqual(first.content, [
    { type: "text", text: "wiring test: step 1" },
    { type: "tool_use", id: "toolu_wiring_0001", name: "sense", input: {} },
  ]);
  assert.equal(first.stop_reason, "tool_use");
  const results = [...wake,
    { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wiring_0001", content: "{}" }] }];
  const second = await scripted.respond("", [], results);
  assert.deepEqual(second.content, [{ type: "text", text: "wiring test: step 2, done" }]);
  assert.equal(second.stop_reason, "end_turn");
  assert.equal(scripted.name, "scripted");
  assert.deepEqual([second.model, second.input_tokens, second.output_tokens], ["scripted", 0, 0]);
});
