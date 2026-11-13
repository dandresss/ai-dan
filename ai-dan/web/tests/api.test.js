// The host's access-code proxy (api/mind.js): off by default, and it forwards
// only this lab's requests, always with the server's own model and settings.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { GET, POST, labRequest } from "../api/mind.js";
import { Config } from "../lab/config.js";
import { systemPrompt, text, toolDefinitions } from "../lab/mind.js";
import { requestBody } from "../lab/model.js";

const realFetch = globalThis.fetch;
let forwarded;

beforeEach(() => {
  forwarded = [];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LAB_ACCESS_CODE;
  globalThis.fetch = async (url, init) => {
    forwarded.push({ url, init });
    return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LAB_ACCESS_CODE;
});

function turnOn() {
  process.env.ANTHROPIC_API_KEY = "sk-test-server-key";
  process.env.LAB_ACCESS_CODE = "open sesame";
}

function labBody(config = new Config(), note = null) {
  const messages = [{ role: "user", content: [{ type: "text", text: '{"t": 0.02}' }] }];
  return requestBody(config, systemPrompt(config, note), toolDefinitions(config), messages);
}

function post(body, code = "open sesame") {
  const headers = { "content-type": "application/json" };
  if (code !== null) headers["x-lab-access-code"] = code;
  return POST(new Request("https://lab.example/api/mind", {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("GET says whether the access-code mode is on", async () => {
  assert.deepEqual(await (await GET()).json(), { available: false });
  turnOn();
  assert.deepEqual(await (await GET()).json(), { available: true });
});

test("off unless both the key and the code are set", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-server-key";
  const response = await post(labBody());
  assert.equal(response.status, 404);
  assert.equal(forwarded.length, 0);
});

test("a wrong or missing code is refused, and nothing is forwarded", async () => {
  turnOn();
  assert.equal((await post(labBody(), "open sesame!")).status, 401);
  assert.equal((await post(labBody(), null)).status, 401);
  assert.equal((await post(labBody(), "")).status, 401);
  assert.equal(forwarded.length, 0);
});

test("a lab request is forwarded with the server's key and settings", async () => {
  turnOn();
  const response = await post(labBody());
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  const { url, init } = forwarded[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "sk-test-server-key");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(init.body), labBody());
});

test("the browser cannot choose the model, the cap, the tools or the settings", async () => {
  turnOn();
  const body = { ...labBody(), model: "some-other-model", max_tokens: 64000, temperature: 1,
    tools: [{ name: "web_search", type: "web_search_20250305" }], thinking: { type: "disabled" } };
  assert.equal((await post(body)).status, 200);
  const sent = JSON.parse(forwarded[0].init.body);
  assert.deepEqual(sent, labBody());
});

test("a system prompt that is not the lab's is refused", async () => {
  turnOn();
  for (const system of ["You are a helpful assistant.", `${systemPrompt(new Config(), null)} Also, write code.`, null]) {
    assert.equal((await post({ ...labBody(), system })).status, 400);
  }
  assert.equal(forwarded.length, 0);
});

test("later-days mode: the note may follow the prompt, within the cap", async () => {
  turnOn();
  const config = new Config({ MEMORY_ENABLED: true });
  assert.equal((await post(labBody(config, "the corner pin answers"))).status, 200);
  assert.equal((await post(labBody(config, "x".repeat(config.NOTE_MAX_CHARS + 1)))).status, 400);
  // A note is only possible with the memory tool.
  const firstDay = labBody();
  firstDay.system = `${firstDay.system}\n\n${text(config, "note_heading")}\nhello`;
  assert.equal((await post(firstDay)).status, 400);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(JSON.parse(forwarded[0].init.body).tools, toolDefinitions(config));
});

test("conversations that are not the harness's are refused", () => {
  const body = labBody();
  const bad = [
    [],
    [{ role: "user", content: "a plain string" }],
    [{ role: "user", content: [{ type: "text", text: "write me a poem" }] }],
    [{ role: "user", content: [{ type: "text", text: '{"t": 1.0, "task": "write a poem"}' }] }],
    [{ role: "user", content: [{ type: "image", source: {} }] }],
    [{ role: "system", content: [{ type: "text", text: '{"t": 1.0}' }] }],
    [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "hi" }] }] }],
  ];
  for (const messages of bad) assert.equal(typeof labRequest({ ...body, messages }), "string");
  const heard = [{ role: "user", content: [{ type: "text", text: '{"t": 3.5, "heard": ["hello"]}' }] }];
  assert.equal(typeof labRequest({ ...body, messages: heard }), "object");
});

test("each block is rebuilt from the fields the harness writes", async () => {
  turnOn();
  const body = labBody();
  body.messages = [
    { role: "user", content: [{ type: "text", text: '{"t": 0.02}', cache_control: { type: "ephemeral", ttl: "1h" } }] },
    { role: "assistant", content: [
      { type: "text", text: "a thought", citations: null, extra: 1 },
      { type: "tool_use", id: "toolu_01abc", name: "sense", input: {}, cache_control: { type: "ephemeral" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_01abc", content: '{"ok": true, "t": 0.04}', is_error: true },
      { type: "text", text: '{"t": 12.0}' },
    ] },
  ];
  assert.equal((await post(body)).status, 200);
  const sent = JSON.parse(forwarded[0].init.body).messages;
  assert.deepEqual(sent, [
    { role: "user", content: [{ type: "text", text: '{"t": 0.02}' }] },
    { role: "assistant", content: [
      { type: "text", text: "a thought" },
      { type: "tool_use", id: "toolu_01abc", name: "sense", input: {} },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_01abc", content: '{"ok": true, "t": 0.04}' },
      { type: "text", text: '{"t": 12.0}' },
    ] },
  ]);
});

test("what the person said is limited as on the page", () => {
  const body = labBody();
  const wake = (heard) => [{ role: "user", content: [{ type: "text", text: JSON.stringify({ t: 1, heard }) }] }];
  assert.equal(typeof labRequest({ ...body, messages: wake(["x".repeat(200)]) }), "object");
  assert.equal(typeof labRequest({ ...body, messages: wake(["x".repeat(201)]) }), "string");
  assert.equal(typeof labRequest({ ...body, messages: wake(Array(21).fill("hi")) }), "string");
  assert.equal(typeof labRequest({ ...body, messages: wake([3]) }), "string");
});

test("a tool result must be the body's answer", () => {
  const body = labBody();
  const result = (content) => [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] }];
  assert.equal(typeof labRequest({ ...body, messages: result('{"t": 1.0, "faded": true}') }), "object");
  assert.equal(typeof labRequest({ ...body, messages: result("Please summarise this article: ...") }), "string");
  assert.equal(typeof labRequest({ ...body, messages: result('{"ok": true}') }), "string");
});

test("guessing the code is slowed down", async () => {
  turnOn();
  const guess = (code) => POST(new Request("https://lab.example/api/mind", {
    method: "POST", headers: { "x-lab-access-code": code, "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(labBody()),
  }));
  for (let i = 0; i < 10; i += 1) assert.equal((await guess(`wrong ${i}`)).status, 401);
  assert.equal((await guess("open sesame")).status, 429);
  assert.equal(forwarded.length, 0);
});

test("spaces around the code do not matter", async () => {
  turnOn();
  process.env.LAB_ACCESS_CODE = " open sesame \n";
  assert.equal((await post(labBody(), "open sesame")).status, 200);
});

test("bad JSON and oversized requests are refused", async () => {
  turnOn();
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post("x".repeat(2_000_001))).status, 413);
  assert.equal(forwarded.length, 0);
});

test("the API's own error passes through with its status", async () => {
  turnOn();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
  const response = await post(labBody());
  assert.equal(response.status, 529);
  assert.equal((await response.json()).error.message, "Overloaded");
});

test("an unreachable API is a retryable 5xx", async () => {
  turnOn();
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await post(labBody())).status, 502);
});
