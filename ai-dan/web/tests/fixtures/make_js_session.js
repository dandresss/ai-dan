// A session run entirely by the JavaScript lab, for the Python lab to check.
//
//     cd web && node tests/fixtures/make_js_session.js
//
// Writes js-session.jsonl next to this file. A scripted person walks in,
// touches the body, speaks, leaves and comes back; a scripted mind (not an AI,
// and labelled so in the header) answers through `world.remoteBody()`, as the
// harness does. ../../tests/test_web_interop.py replays the file with
// lab.world.verify_log: same results, same state hashes, or the port is wrong.
//
// Nothing here reads the wall clock: the header's started_at is fixed, so the
// file is the same every time it is made.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Config } from "../../lab/config.js";
import { SessionLog } from "../../lab/log.js";
import { pyDumps } from "../../lab/py.js";
import { World } from "../../lab/world.js";

const OUT = new URL("./js-session.jsonl", import.meta.url);
const TOOLS = ["play", "stop", "sense", "set_color"];
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

// The mind's moves, by turn. The scripted mind is deliberately mechanical.
const TURNS = {
  arrival: [
    ["sense", {}],
    ["play", { tracks: [{ pins: "all", keyframes: [[0, 0.2], [2, 0.8], [4, 0.2]], loop: true }] }],
    ["set_color", { rgb: [80, 160, 255] }],
  ],
  voice: [
    ["sense", {}],
    ["play", { tracks: [
      { pins: [[0, 0], [0, 1], [1, 0], [1, 1]], keyframes: [[0, 0], [0.4, 1], [0.8, 0.1]], ease: "linear", delay_s: 0.5 },
      { pins: [[7, 7], [6, 6]], keyframes: [[0, 1], [1.5, 0.3]], loop: true },
      { pins: [[7, 7]], keyframes: [[0, 0.5], [0.25, 0.9], [0.5, 0.5]], loop: true }] }],
    ["stop", { pins: [[4, 4], [4, 5]] }],
    ["fly", { to: "the moon" }],
  ],
  departure: [
    ["stop", null],
    ["set_color", { rgb: [20, 20, 40.0] }],
    ["play", { tracks: [{ pins: [[8, 8]], keyframes: [[0, 1], [1, 0]] }] }],
  ],
  return: [
    ["play", { tracks: "breathe" }],
    ["sense", null],
    ["play", { tracks: [{ pins: "all", keyframes: [[0, 0], [1, 1]], delay_s: Infinity }] }],   // a model's 1e400
    ["play", { tracks: [{ pins: "all", keyframes: [[0, -1], [0.75, 2], [1.5, 0.5]], ease: "smooth" }] }],
    ["sense", {}],
  ],
};

export async function makeJsSession() {
  const config = new Config();
  const log = new SessionLog({ now: () => new Date(2026, 10, 12, 12, 0, 0) });
  const world = new World(config, log);
  const body = world.remoteBody();
  const prompt = bundledPrompt(config);

  // As harness.js writes it: the header first, before the person arrives.
  log.writeHeader(config, {
    t: world.t, prompt_version: config.PROMPT_VERSION, prompt, model: "scripted",
    tools: TOOLS, memory_enabled: config.MEMORY_ENABLED, mind: "scripted",
  });

  let turn = 0;
  const harnessLog = (event) => log.write({ type: event.type, t: world.t, ...event });
  async function runTurn(reasons, moves) {
    turn += 1;
    world.turn = turn;
    harnessLog({ type: "wake", turn, reasons, message: pyDumps({ t: world.t }) });
    for (const [name, args] of moves) await body.call(name, args);
    harnessLog({ type: "turn_end", turn, tool_calls: moves.length, capped: false, skipped: false });
  }

  // The mind: listens on world.events, one turn at a time, like the harness.
  let away = false;
  let busy = Promise.resolve();
  const listen = () => {
    while (world.events.length > 0) {
      const [kind] = world.events.shift();
      if (kind === "enter") busy = busy.then(() => runTurn(["arrival"], away ? TURNS.return : TURNS.arrival));
      if (kind === "voice") busy = busy.then(() => runTurn(["voice"], TURNS.voice));
      if (kind === "leave") busy = busy.then(() => runTurn(["departure"], TURNS.departure));
      away = away || kind === "leave";
    }
  };

  for (let k = 0; k < TICKS; k++) {
    if (VOICES[k]) world.say(VOICES[k]);
    world.tick(person(k), pressed(k));
    listen();
    await new Promise((resolve) => setImmediate(resolve));   // let the mind take its answers
  }

  world.close();
  await busy.catch(() => {});
  log.write({ type: "close", t: world.t, reason: "window_closed", turns: turn, input_tokens: 0, output_tokens: 0 });
  log.close();
  return log.text();
}

// The system prompt of the bundled first session: same prompt version, and
// the exact text the Python lab sends.
function bundledPrompt(config) {
  const first = readFileSync(new URL("../../sessions/first-wake.jsonl", import.meta.url), "utf8").split("\n")[0];
  const header = JSON.parse(first);
  if (header.prompt_version !== config.PROMPT_VERSION || header.config.LANGUAGE !== config.LANGUAGE) {
    throw new Error("the bundled session was made with another prompt");
  }
  return header.prompt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await makeJsSession();
  writeFileSync(OUT, text, "utf8");
  console.log(`${fileURLToPath(OUT)}: ${text.split("\n").length - 1} lines`);
}
