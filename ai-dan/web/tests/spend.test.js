// The hard spending limit (api/_spend.js, used by api/mind.js): nothing is sent
// that could take the host past LIMIT_USD, and what is sent is counted at what
// the API says it cost.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { GET, POST } from "../api/mind.js";
import { LIMIT_USD, PRICES, costOf, worstCase } from "../api/_spend.js";
import { Config } from "../lab/config.js";
import { systemPrompt, toolDefinitions } from "../lab/mind.js";
import { requestBody } from "../lab/model.js";
import { storeFails, storeOff, storeOn, storeValue, withStore } from "./spend_store.js";

const LIMIT = LIMIT_USD * 1_000_000;
const realFetch = globalThis.fetch;
let sent;

/** The API stand-in: answers with this usage, or the status given. */
function api({ usage = { input_tokens: 1_000, output_tokens: 100 }, status = 200, fail = false } = {}) {
  globalThis.fetch = withStore(async (url, init) => {
    if (fail) throw new TypeError("fetch failed");
    sent.push(JSON.parse(init.body));
    const body = status === 200
      ? { content: [{ type: "text", text: "hm" }], stop_reason: "end_turn", usage }
      : { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  sent = [];
  process.env.ANTHROPIC_API_KEY = "sk-test-server-key";
  process.env.LAB_ACCESS_CODE = "open sesame";
  storeOn();
  api();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LAB_ACCESS_CODE;
  storeOff();
});

const config = new Config();
const body = (text = "") => requestBody(config, systemPrompt(config, null), toolDefinitions(config), [
  { role: "user", content: [{ type: "text", text: JSON.stringify({ t: 1, ...(text ? { heard: [text] } : {}) }) }] },
]);
const post = (request = body()) => POST(new Request("https://lab.example/api/mind", {
  method: "POST",
  headers: { "content-type": "application/json", "x-lab-access-code": "open sesame" },
  body: JSON.stringify(request),
}));

test("the limit is ten dollars, and the model has a price", () => {
  assert.equal(LIMIT_USD, 10);
  assert.ok(PRICES[config.MODEL], `no price for ${config.MODEL}`);
});

test("cost: tokens times dollars per million, in millionths of a dollar", () => {
  assert.equal(costOf("claude-sonnet-5-5", { input_tokens: 1_000_000 }), 2_000_000);
  assert.equal(costOf("claude-sonnet-5-5", { output_tokens: 1_000_000 }), 10_000_000);
  assert.equal(costOf("claude-sonnet-5-5", { input_tokens: 1_000, output_tokens: 100,
    cache_creation_input_tokens: 10, cache_read_input_tokens: 10, server_tool_use: {} }), 1_000 * 2 + 100 * 10 + 40 + 1);
});

test("the worst case covers any answer the request can get", () => {
  const request = body();
  const bytes = Buffer.byteLength(JSON.stringify(request));
  // Even if every byte were a token, the output ran to max_tokens, and all of it was a cache write.
  const dearest = costOf(request.model, { input_tokens: bytes, output_tokens: request.max_tokens });
  assert.ok(worstCase(request) >= dearest);
  assert.ok(worstCase(request) >= costOf(request.model, { cache_creation_input_tokens: bytes, output_tokens: request.max_tokens }));
});

test("a request is counted at what its usage says", async () => {
  assert.equal((await post()).status, 200);
  assert.equal(storeValue(), 1_000 * 2 + 100 * 10);
  const answer = await (await GET()).json();
  assert.equal(answer.available, true);
  assert.equal(answer.spent_usd, 0);   // $0.003 rounds to 0 cents
});

test("an API error is not counted", async () => {
  api({ status: 529 });
  assert.equal((await post()).status, 529);
  assert.equal(storeValue(), 0);
});

test("an answer that never came keeps its reservation: it may have been billed", async () => {
  api({ fail: true });
  assert.equal((await post()).status, 502);
  assert.equal(storeValue(), worstCase(body()));
});

test("a success without usage is counted at its worst case", async () => {
  api({ usage: null });
  assert.equal((await post()).status, 200);
  assert.equal(storeValue(), worstCase(body()));
});

test("past the limit nothing is sent, and the page is told why", async () => {
  storeOn(LIMIT - worstCase(body()) + 1);
  const response = await post();
  assert.equal(response.status, 402);
  assert.match((await response.json()).error.message, /\$10 limit/);
  assert.deepEqual(sent, []);
  assert.equal(storeValue(), LIMIT - worstCase(body()) + 1);   // the refused reservation was given back

  storeOn(LIMIT);
  const answer = await (await GET()).json();
  assert.equal(answer.available, false);
  assert.equal(answer.spent_usd, 10);
  assert.match(answer.reason, /\$10 limit/);
});

test("requests at the same moment cannot overshoot the limit together", async () => {
  const each = worstCase(body("x"));
  storeOn(LIMIT - Math.floor(2.5 * each));      // room for two worst cases, not three
  api({ usage: { input_tokens: 1, output_tokens: 1 } });
  const answers = await Promise.all(Array.from({ length: 8 }, () => post(body("x"))));
  const statuses = answers.map((r) => r.status).sort();
  assert.deepEqual(statuses.filter((s) => s === 200).length <= 2, true, `statuses ${statuses}`);
  assert.ok(storeValue() <= LIMIT);
});

test("without a store there is no count here: the Console limit is the cap", async () => {
  storeOff();
  assert.deepEqual(await (await GET()).json(), { available: true, code: true });
  assert.equal((await post()).status, 200);
  assert.equal(sent.length, 1);
});

test("a store that is attached but failing stops the mind", async () => {
  storeFails();
  const response = await post();
  assert.equal(response.status, 403);
  assert.match((await response.json()).error.message, /cannot count/);
  assert.equal((await (await GET()).json()).available, false);
  assert.deepEqual(sent, []);
});
