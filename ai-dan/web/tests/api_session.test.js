// A whole session through the access-code proxy: the real World, Harness and
// AnthropicModel, with api/mind.js in between and a stand-in for the API
// behind it. Every request the harness makes must pass the proxy's checks.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { POST } from "../api/mind.js";
import { Config } from "../lab/config.js";
import { Harness } from "../lab/harness.js";
import { SessionLog } from "../lab/log.js";
import { AnthropicModel } from "../lab/model.js";
import { World } from "../lab/world.js";
import { storeOff, storeOn, storeValue, withStore } from "./spend_store.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LAB_ACCESS_CODE;
  storeOff();
});

/** Answers like the Messages API: a turn opens with thinking and two calls, then ends. */
function standInApi(requests) {
  let ids = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const last = body.messages.at(-1).content;
    const wake = last.some((block) => block.type === "text");
    const content = wake
      ? [
          { type: "thinking", thinking: "Something is here. I will look, then move.", signature: `sig${++ids}` },
          { type: "text", text: "I look." },
          { type: "tool_use", id: `toolu_${++ids}`, name: "sense", input: {} },
          { type: "tool_use", id: `toolu_${++ids}`, name: "play",
            input: { tracks: [{ pins: "all", keyframes: [[0, 0], [1, 0.6], [2, 0]], loop: true }] } },
          ...(body.tools.some((tool) => tool.name === "remember")
            ? [{ type: "tool_use", id: `toolu_${++ids}`, name: "remember", input: { text: "a slow swell\r\nanswers hello" } }]
            : []),
        ]
      : [{ type: "text", text: "Done for now." }];
    return new Response(JSON.stringify({
      id: `msg_${ids}`, type: "message", role: "assistant", model: body.model, content,
      stop_reason: wake ? "tool_use" : "end_turn", usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function session(config, noteStore = null) {
  process.env.ANTHROPIC_API_KEY = "sk-test-server-key";
  process.env.LAB_ACCESS_CODE = "open sesame";
  storeOn();
  const requests = [];
  globalThis.fetch = withStore(standInApi(requests));
  const throughProxy = (url, init) => POST(new Request(new URL(url, "https://lab.example"), init));
  const model = new AnthropicModel(config, { accessCode: "open sesame" }, { fetch: throughProxy });

  const log = new SessionLog();
  const world = new World(config, log);
  const harness = new Harness(world, model, config, { noteStore, sleep: async () => {} });
  harness.start({ runLoop: false });
  let running = null;
  for (let k = 0; k < 1500; k += 1) {             // 30 s: arrival, a voice, two pulses
    if (k === 300) world.say("hello");
    world.tick([3.5, 9.2], k >= 400 && k < 450 ? [2, 2] : null);
    running ??= harness.step().finally(() => { running = null; });
    await new Promise((resolve) => setImmediate(resolve));
  }
  world.close();
  await harness.stop();
  log.close();
  const events = log.text().trim().split("\n").map((line) => JSON.parse(line));
  return { events, requests };
}

test("a first-day session passes the proxy on every request", async () => {
  const { events, requests } = await session(new Config());
  const errors = events.filter((event) => event.type === "api_error");
  assert.deepEqual(errors, []);
  const wakes = events.filter((event) => event.type === "wake");
  assert.ok(wakes.length >= 3, `only ${wakes.length} wakes`);
  assert.ok(wakes.some((wake) => wake.reasons.includes("voice")));
  assert.equal(requests.length, 2 * wakes.length);
  assert.ok(events.some((event) => event.type === "call" && event.name === "play" && event.result.ok));
  // Each answer reported 100 tokens in and 20 out: $0.0004 at $2 and $10 per million.
  assert.equal(storeValue(), requests.length * 400);
});

test("a later-days session with a note passes the proxy too", async () => {
  const store = new Map([["ai-dan.note", "The light came back twice."]]);
  const noteStore = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const { events, requests } = await session(new Config({ MEMORY_ENABLED: true }), noteStore);
  assert.deepEqual(events.filter((event) => event.type === "api_error"), []);
  assert.ok(requests[0].system.endsWith("The light came back twice."));
  assert.ok(requests[0].tools.some((tool) => tool.name === "remember"));
  assert.ok(events.some((event) => event.type === "call" && event.name === "remember" && event.result.ok));
});
