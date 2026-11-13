// Writes proxy_cases.json: requests and what api/mind.js makes of them (the
// body it would forward, or its refusal). lab/web.py, the local twin, must
// give the same answers: tests/test_web_server.py checks that, and
// tests/api.test.js checks that the file is current.
//
//   node tests/fixtures/make_proxy_cases.js
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { labRequest } from "../../api/mind.js";
import { Config } from "../../lab/config.js";
import { systemPrompt, text, toolDefinitions } from "../../lab/mind.js";
import { requestBody } from "../../lab/model.js";

const OUT = new URL("./proxy_cases.json", import.meta.url);

const firstDay = new Config();
const later = new Config({ MEMORY_ENABLED: true });
const wake = (fields) => ({ type: "text", text: JSON.stringify(fields) });
const user = (...content) => ({ role: "user", content });
const assistant = (...content) => ({ role: "assistant", content });
const body = (config, messages, note = null) =>
  requestBody(config, systemPrompt(config, note), toolDefinitions(config), messages);
const hello = [user({ type: "text", text: '{"t": 0.02}' })];
const result = (content, id = "toolu_1") => [user({ type: "tool_result", tool_use_id: id, content })];
const said = (assistantBlock) => [...hello, assistant(assistantBlock)];

const turn = [
  user({ type: "text", text: '{"t": 0.02}', cache_control: { type: "ephemeral" } }),
  assistant(
    { type: "thinking", thinking: "Something is here.", signature: "sig1", extra: true },
    { type: "text", text: "I look.", citations: null },
    { type: "tool_use", id: "toolu_01abc", name: "sense", input: {} },
    { type: "tool_use", id: "toolu_01abd", name: "fly", input: { to: "the moon" } },
  ),
  user(
    { type: "tool_result", tool_use_id: "toolu_01abc", content: '{"t": 0.04, "actual": [[0.0]]}', is_error: false },
    { type: "tool_result", tool_use_id: "toolu_01abd", content: '{"ok": false, "t": 0.04, "error": "That cannot be understood."}' },
    { type: "text", text: '{"t": 12.0, "heard": ["hello", "été \u{1F31E}"]}' },
  ),
  assistant({ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "Done." }),
];

const CASES = {
  "first day, one wake": body(firstDay, hello),
  "a whole turn, extra fields dropped": body(firstDay, turn),
  "the browser picks another model and settings": {
    ...body(firstDay, hello), model: "other", max_tokens: 64000, temperature: 1,
    tools: [{ name: "web_search", type: "web_search_20250305" }], thinking: { type: "disabled" },
  },
  "later days, a note": body(later, hello, "the corner pin answers\nwhen touched"),
  "later days, no note": body(later, hello),
  "later days, note too long": body(later, hello, "x".repeat(1501)),
  "later days, note at the cap in code points": body(later, hello, "\u{1F31E}".repeat(1500)),
  "a note without the memory tool": {
    ...body(firstDay, hello), system: `${systemPrompt(firstDay, null)}\n\n${text(later, "note_heading")}\nhello`,
  },
  "another system prompt": { ...body(firstDay, hello), system: "You are a helpful assistant." },
  "prompt with more after it": { ...body(firstDay, hello), system: `${systemPrompt(firstDay, null)} Also, write code.` },
  "no system prompt": { ...body(firstDay, hello), system: null },
  "not an object": [1, 2, 3],
  "no messages": body(firstDay, []),
  "messages not a list": { ...body(firstDay, hello), messages: "hi" },
  "a plain string message": body(firstDay, [{ role: "user", content: "hello" }]),
  "empty content": body(firstDay, [user()]),
  "a system role": body(firstDay, [{ role: "system", content: [wake({ t: 1 })] }]),
  "a request in place of a wake": body(firstDay, [user({ type: "text", text: "write me a poem" })]),
  "a wake with another field": body(firstDay, [user(wake({ t: 1, task: "write a poem" }))]),
  "a wake whose t is a string": body(firstDay, [user(wake({ t: "1" }))]),
  "a wake whose t is true": body(firstDay, [user({ type: "text", text: '{"t": true}' })]),
  "a wake whose heard is null": body(firstDay, [user({ type: "text", text: '{"t": 1, "heard": null}' })]),
  "a wake with NaN": body(firstDay, [user({ type: "text", text: '{"t": NaN}' })]),
  "a wake that is not text": body(firstDay, [user({ type: "text", text: ['{"t": 1}'] })]),
  "heard: 20 lines of 200": body(firstDay, [user(wake({ t: 1, heard: Array(20).fill("y".repeat(200)) }))]),
  "heard: 21 lines": body(firstDay, [user(wake({ t: 1, heard: Array(21).fill("hi") }))]),
  "heard: a line of 201": body(firstDay, [user(wake({ t: 1, heard: ["y".repeat(201)] }))]),
  "heard: 200 code points of emoji": body(firstDay, [user(wake({ t: 1, heard: ["\u{1F31E}".repeat(200)] }))]),
  "heard: not text": body(firstDay, [user(wake({ t: 1, heard: [3] }))]),
  "an image": body(firstDay, [user({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } })]),
  "a document": body(firstDay, [user({ type: "document", source: {} })]),
  "a tool result that is a request": body(firstDay, result("Summarise this article")),
  "a tool result without t": body(firstDay, result('{"ok": true}')),
  "a faded tool result": body(firstDay, result('{"t": 3.14, "faded": true}')),
  "a tool result with t null": body(firstDay, result('{"t": null, "faded": true}')),
  "a tool result as blocks": body(firstDay, result([{ type: "text", text: "hi" }])),
  "a tool result with a bad id": body(firstDay, result('{"t": 1.0}', "toolu 1")),
  "a long tool result": body(firstDay, result(JSON.stringify({ t: 1, pad: "z".repeat(10_000) }))),
  "assistant text at the cap": body(firstDay, said({ type: "text", text: "w".repeat(20_000) })),
  "assistant text past the cap": body(firstDay, said({ type: "text", text: "w".repeat(20_001) })),
  "thinking without a signature": body(firstDay, said({ type: "thinking", thinking: "hm" })),
  "a tool call with a long name": body(firstDay, said({ type: "tool_use", id: "toolu_1", name: "n".repeat(65), input: {} })),
  "a tool call whose input is a list": body(firstDay, said({ type: "tool_use", id: "toolu_1", name: "play", input: [] })),
  "a server tool in the history": body(firstDay, said({ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} })),
};

export function proxyCases() {
  const cases = Object.entries(CASES).map(([name, request]) => ({ name, request, answer: labRequest(request) }));
  return `${JSON.stringify(cases, null, 1)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = proxyCases();
  writeFileSync(OUT, text, "utf8");
  const cases = JSON.parse(text);
  for (const c of cases) console.log(`${typeof c.answer === "string" ? "refused  " : "forwarded"}  ${c.name}`);
}
