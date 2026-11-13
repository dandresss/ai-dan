// What the mind reads, checked against the Python lab and the spec files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { Config } from "../lab/config.js";
import {
  NOTE_KEY, PROMPTS, TEXT, loadNote, saveNote, systemPrompt, text, thinkingParam, toolDefinitions,
} from "../lab/mind.js";
import { Harness } from "../lab/harness.js";
import { FakeModel, FakeWorld, noSleep, response, use } from "./harness_fakes.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mind.json", import.meta.url), "utf8"));
const SPECS = new URL("../../../", import.meta.url);   // the folder with mind.md and body-contract.md
const haveSpecs = existsSync(new URL("mind.md", SPECS));
const spec = (name) => readFileSync(new URL(name, SPECS), "utf8");

const memoryStore = (initial = null) => {
  const items = new Map(initial === null ? [] : [[NOTE_KEY, initial]]);
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
};

function specPrompt() {
  const block = spec("mind.md").split("## Discovery prompt, version `mind-v0`")[1];
  return block.split("```")[1].replace(/^\n+|\n+$/g, "");
}

// --- the Python lab's output, exactly ----------------------------------------

const configs = {
  first_day: new Config(),
  memory_no_note: new Config({ MEMORY_ENABLED: true }),
  memory_with_note: new Config({ MEMORY_ENABLED: true }),
};

for (const [mode, config] of Object.entries(configs)) {
  test(`mind.js equals the Python: ${mode}`, () => {
    const note = mode === "memory_with_note" ? fixture.note : null;
    assert.equal(systemPrompt(config, note), fixture.modes[mode].system_prompt);
    assert.deepEqual(toolDefinitions(config), fixture.modes[mode].tool_definitions);
    // Same JSON text too, so key order is the same on the wire.
    assert.equal(JSON.stringify(toolDefinitions(config)),
                 JSON.stringify(fixture.modes[mode].tool_definitions));
  });
}

test("thinking and the text table equal the Python", () => {
  assert.deepEqual(thinkingParam(new Config()), fixture.thinking_param.adaptive);
  assert.deepEqual(thinkingParam(new Config({ THINKING: "between_tools" })),
                   fixture.thinking_param.between_tools);
  assert.deepEqual(TEXT, fixture.TEXT);
  assert.equal(text(new Config(), "past_cap"), "That is too much for one moment.");
});

// --- the spec files themselves ------------------------------------------------

test("the prompt is the spec word for word", { skip: !haveSpecs }, () => {
  assert.equal(PROMPTS["mind-v0"].en, specPrompt());
  assert.equal(systemPrompt(new Config(), null), specPrompt());
});

test("body tool descriptions are the contract word for word", { skip: !haveSpecs }, () => {
  const described = {};
  for (const m of spec("body-contract.md").matchAll(/### `(\w+)`\s+Visible description: "([^"]+)"/g)) {
    described[m[1]] = m[2];
  }
  const tools = Object.fromEntries(toolDefinitions(new Config()).map((t) => [t.name, t.description]));
  assert.deepEqual(tools, described);
});

test("the remember description is the spec word for word", { skip: !haveSpecs }, () => {
  const tools = Object.fromEntries(
    toolDefinitions(new Config({ MEMORY_ENABLED: true })).map((t) => [t.name, t]));
  assert.ok(spec("mind.md").includes(`Visible description: "${tools.remember.description}"`));
});

test("schemas say shapes, not limits", () => {
  for (const config of [new Config(), new Config({ MEMORY_ENABLED: true })]) {
    for (const tool of toolDefinitions(config)) {
      const schema = JSON.stringify(tool.input_schema);
      for (const word of ["minimum", "maximum", "minItems", "maxItems", "maxLength", "default"]) {
        assert.ok(!schema.includes(word), `${tool.name}: ${word}`);
      }
      for (const m of schema.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)) {
        assert.ok(!/\d/.test(m[1]), `${tool.name}: ${m[1]}`);
      }
    }
  }
  const track = toolDefinitions(new Config())[0].input_schema.properties.tracks.items;
  assert.deepEqual(new Set(Object.keys(track.properties)),
                   new Set(["pins", "keyframes", "loop", "delay_s", "ease"]));
  assert.deepEqual(track.required, ["pins", "keyframes"]);
  assert.deepEqual(track.properties.ease.enum, ["smooth", "linear"]);
});

// --- the modes, through the harness -------------------------------------------

async function firstTurn(config, script, store) {
  const world = new FakeWorld();
  const model = new FakeModel(script);
  const h = new Harness(world, model, config, { noteStore: store, sleep: noSleep });
  h.start({ runLoop: false });
  world.enter();
  await h.step();
  return { world, model, h };
}

test("first-day mode has no remember and no note", async () => {   // mind.md criterion 2
  const config = new Config();
  assert.ok(!toolDefinitions(config).some((t) => t.name === "remember"));
  assert.equal(systemPrompt(config, "I was here"), PROMPTS["mind-v0"].en);
  const { model } = await firstTurn(config, [], memoryStore("I was here"));
  assert.equal(model.systems[0], PROMPTS["mind-v0"].en);
  assert.deepEqual(model.tools[0].map((t) => t.name), ["play", "stop", "sense", "set_color"]);
});

test("a note carries to the next session", async () => {   // mind.md criterion 3
  const store = memoryStore();
  const config = new Config({ MEMORY_ENABLED: true });
  const first = await firstTurn(config, [response(use("remember", { text: "I rose once." }))], store);
  assert.equal(first.model.systems[0], PROMPTS["mind-v0"].en);   // no note yet
  assert.ok(first.model.tools[0].some((t) => t.name === "remember"));
  await first.h.stop();

  const second = await firstTurn(config, [], store);
  assert.equal(second.model.systems[0],
               PROMPTS["mind-v0"].en + "\n\nYou left yourself this:\nI rose once.");
  assert.equal(second.world.logged("header")[0].prompt, second.model.systems[0]);
});

test("a note over the cap is rejected and the old one kept", () => {   // mind.md criterion 4
  const store = memoryStore();
  const config = new Config({ MEMORY_ENABLED: true });
  assert.equal(saveNote(config, store, { text: "keep this" }), null);
  assert.equal(saveNote(config, store, { text: "x".repeat(1501) }),
               "That does not fit. You will have to keep less.");
  assert.equal(loadNote(store), "keep this");
  assert.equal(saveNote(config, store, { text: "y".repeat(1500) }), null);
  assert.equal(loadNote(store), "y".repeat(1500));
});

test("the cap counts characters, not UTF-16 units", () => {
  const store = memoryStore();
  const config = new Config({ MEMORY_ENABLED: true, NOTE_MAX_CHARS: 3 });
  assert.equal(saveNote(config, store, { text: "\u{1F600}\u{1F600}\u{1F600}" }), null);
  assert.equal(saveNote(config, store, { text: "abcd" }), text(config, "note_too_long"));
});

test("a note that is not text is refused", () => {
  const store = memoryStore("old");
  const config = new Config({ MEMORY_ENABLED: true });
  for (const args of [{ text: 7 }, {}, null, undefined, "text", ["text"], { text: null }]) {
    assert.equal(saveNote(config, store, args), "That note cannot be understood.");
  }
  assert.equal(loadNote(store), "old");
});

test("a rejected note through the harness", async () => {
  const store = memoryStore("old");
  const script = [response(use("remember", { text: "z".repeat(2000) })),
                  response(use("remember", { text: 7 }))];
  const { world } = await firstTurn(new Config({ MEMORY_ENABLED: true }), script, store);
  const results = world.logged("call").map((e) => e.result);
  assert.deepEqual(results[0], { ok: false, t: 0, error: "That does not fit. You will have to keep less." });
  assert.equal(results[1].ok, false);
  assert.equal(loadNote(store), "old");
});

test("no note means no note", () => {
  assert.equal(loadNote(memoryStore()), null);
  assert.equal(loadNote(null), null);
  const config = new Config({ MEMORY_ENABLED: true });
  assert.equal(systemPrompt(config, null), PROMPTS["mind-v0"].en);
  assert.equal(systemPrompt(config, ""), PROMPTS["mind-v0"].en);
});
