// A session run entirely by the JavaScript lab, for the Python lab to check.
//
//     cd web && node tests/fixtures/make_js_session.js
//
// Writes js-session.jsonl next to this file. A scripted person walks in,
// touches the body, speaks, leaves and comes back, on a real World; the real
// Harness wakes a scripted mind (not an AI, and labelled so in the header) and
// carries its calls to the body. ../../tests/test_web_interop.py replays the
// file with lab.world.verify_log: same results, same state hashes, or the port
// is wrong, and every line is what json.dumps writes.
//
// Nothing here reads the wall clock or waits on a timer: the header's
// started_at is fixed and the clock is the tick count, so the file is the same
// every time it is made.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Config } from "../../lab/config.js";
import { Harness } from "../../lab/harness.js";
import { SessionLog } from "../../lab/log.js";
import { World } from "../../lab/world.js";

const OUT = new URL("./js-session.jsonl", import.meta.url);
const TICKS = 720;

// The person: arrives at tick 20, walks in, touches two pins, speaks, leaves
// at 330 and is back at 480.
function person(k) {
  if (k < 20 || (k >= 330 && k < 480)) return null;
  if (k < 120) return [9.5 - (k - 20) * 0.055, 4.0 + (k - 20) * 0.0125];   // walks in over the edge
  return [3.5 + Math.sin(k / 23) * 0.73, 3.5 + Math.cos(k / 31) * 1.215];
}

function pressed(k) {
  if (k >= 150 && k < 180) return [3, 3];
  if (k >= 180 && k < 200) return [3.6, 4.2];          // the pin under the pointer: (3, 4)
  if (k >= 600 && k < 605) return [8, 1];              // off the body: no press
  return null;
}

const VOICES = { 200: "  hello there  ", 210: "   ", 520: "you moved?" };

// What the scripted mind does in each turn it is woken for: arrival, the first
// voice, the departure, the return, the second voice. Deliberately awkward
// calls are in here on purpose (an unknown tool, null arguments, a number too
// large for a float): the body must answer them exactly as the Python one does.
const TURNS = [
  [
    ["sense", {}],
    ["play", { tracks: [{ pins: "all", keyframes: [[0, 0.2], [2, 0.8], [4, 0.2]], loop: true }] }],
    ["set_color", { rgb: [80, 160, 255] }],
  ],
  [
    ["sense", {}],
    ["play", { tracks: [
      { pins: [[0, 0], [0, 1], [1, 0], [1, 1]], keyframes: [[0, 0], [0.4, 1], [0.8, 0.1]], ease: "linear", delay_s: 0.5 },
      { pins: [[7, 7], [6, 6]], keyframes: [[0, 1], [1.5, 0.3]], loop: true },
      { pins: [[7, 7]], keyframes: [[0, 0.5], [0.25, 0.9], [0.5, 0.5]], loop: true }] }],
    ["stop", { pins: [[4, 4], [4, 5]] }],
    ["fly", { to: "the moon" }],
  ],
  [
    ["stop", null],
    ["set_color", { rgb: [20, 20, 40.0] }],
    ["play", { tracks: [{ pins: [[8, 8]], keyframes: [[0, 1], [1, 0]] }] }],
  ],
  [
    ["play", { tracks: "breathe" }],
    ["sense", null],
    ["play", { tracks: [{ pins: "all", keyframes: [[0, 0], [1, 1]], delay_s: Infinity }] }],   // a model's 1e400
    ["play", { tracks: [{ pins: "all", keyframes: [[0, -1], [0.75, 2], [1.5, 0.5]], ease: "smooth" }] }],
    ["sense", {}],
  ],
  [
    ["sense", {}],
    ["set_color", { rgb: [255, 255, 255] }],
  ],
];

// A model that plays TURNS: each turn is one response with all its calls,
// then one that ends the turn. It answers instantly, so the clock is the ticks.
class ScriptedTurns {
  constructor() {
    this.name = "scripted";
    this.turn = -1;
    this.answered = false;
    this.responses = 0;
  }

  async respond(system, tools, messages) {
    const last = messages[messages.length - 1].content;
    if (last.some((b) => b.type === "text")) {   // a wake begins a turn
      this.turn += 1;
      this.answered = false;
    }
    const moves = this.answered ? [] : (TURNS[this.turn] ?? []);
    this.answered = true;
    this.responses += 1;
    const content = [{ type: "text", text: `scripted turn ${this.turn + 1}, step ${this.responses}` }];
    moves.forEach(([name, args], i) => content.push({
      type: "tool_use", id: `toolu_scripted_${this.turn + 1}_${i + 1}`, name, input: args,
    }));
    return {
      content, stop_reason: moves.length ? "tool_use" : "end_turn", model: this.name,
      input_tokens: 0, output_tokens: 0,
    };
  }
}

export async function makeJsSession() {
  const config = new Config();
  const log = new SessionLog({ now: () => new Date(2026, 10, 12, 12, 0, 0) });
  const world = new World(config, log);
  const harness = new Harness(world, new ScriptedTurns(), config, { sleep: async () => {} });
  harness.start({ runLoop: false });   // the header, first, before the person arrives

  // The window ticks; between ticks the mind looks at the world, as its loop
  // does. A turn waits for the next tick to have its body calls answered.
  let looking = null;
  for (let k = 0; k < TICKS; k++) {
    if (VOICES[k]) world.say(VOICES[k]);
    world.tick(person(k), pressed(k));
    looking ??= harness.step().finally(() => { looking = null; });
    await new Promise((resolve) => setImmediate(resolve));   // let the mind take its answers
  }

  world.close();
  await harness.stop();
  log.close();
  return log.text();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await makeJsSession();
  writeFileSync(OUT, text, "utf8");
  console.log(`${fileURLToPath(OUT)}: ${text.split("\n").length - 1} lines`);
}
