# The lab in a web page: the team contract

The desktop lab (`../lab/`, Python) is the instrument. This folder is the same
lab running in a browser, served by Vercel's free tier. It is a **port**, not
a reinterpretation: the body, the contract and the mind loop must behave
exactly like the Python code, so that

- a session log written by the desktop lab replays in the browser to the
  same body states (`state` hashes match), and
- a session log downloaded from the browser passes `uv run python main.py
  --verify FILE` and is read by `python -m lab.analyze` like any other.

Read `../ARCHITECTURE.md` first. Everything it says about time, conventions,
the log format and the decisions the specs left open holds here too. The
Python modules are the reference: when this file and the Python code
disagree on behaviour, the Python code wins and you say so in your report.

The demo is an invitation. It must open fast, look alive and stay honest:
nothing on screen may suggest the body does something the mind did not order.

## Layout and ownership

```
web/                         Vercel project root ("Root Directory" = ai-dan/web)
  ARCHITECTURE.md   lead
  package.json      lead     {"type": "module"}, no dependencies, `npm test`
  vercel.json       lead     headers, function settings
  .vercelignore     lead
  index.html        ui
  style.css         ui
  api/mind.js       lead     optional proxy to the Anthropic API (owner's key, access code)
  sessions/first-wake.jsonl  lead   copy of ../docs/first-wake.jsonl
  lab/
    py.js           body     Python-compatible numbers, JSON and SHA-256
    config.js       body     Config: every parameter, same names, same defaults, same order
    nervous.js      body     port of lab/nervous.py
    display.js      body     port of lab/display.py
    contract.js     body     port of lab/contract.py
    simbody.js      body     port of lab/simbody.py
    log.js          body     SessionLog (in memory), Feed, parseLog
    world.js        body     World, ReplayWorld, verifyLog, WorldClosed
    mind.js         mind     port of lab/mind.py (prompt, texts, tools, the note)
    model.js        mind     AnthropicModel (direct or through api/mind.js), ScriptedModel
    harness.js      mind     port of lab/harness.py, async
    render.js       ui       port of lab/render.py to a 2D canvas: layout, room, pins, person
    render-base.js  ui       palette, fonts, wrapping, Python number formats
    render-chrome.js ui      intro, status line, banners, help
    render-panel.js ui       the observer: reading the feed, call summaries, the panel
    app.js          ui       the page
    ui-start.js     ui       the start screen
    ui-session.js   ui       a session's lifecycle: start, end, download
    ui-loop.js      ui       the fixed-step loop and the pointer
  tests/            each owner: `<module>.test.js`, run with `node --test`
    fixtures/       generated from the Python lab by scripts kept next to them
../tests/test_web_interop.py   the Python lab verifies a log written by the web lab
```

Rules for the team:

- Edit only the files you own. If a lead file blocks you, work around it and
  say so in your report.
- Plain modern JavaScript: ES modules, no build step, no dependencies, no
  framework, no TypeScript. The browser loads `lab/*.js` as they are; Node
  imports the same files in tests; `api/mind.js` imports `lab/config.js`,
  `lab/mind.js` and `lab/model.js` on the server. So modules under `lab/`
  other than `render.js` and `app.js` must not touch `window`, `document`,
  `localStorage` or the canvas at import time or in their logic; pass such
  things in.
- Readable code, short modules, comments only where the reason is not
  obvious. Keep the Python names for data that crosses a boundary (log
  events, snapshots, tool results: `gap_max`, `input_tokens`, `tool_calls`).
  Methods are camelCase (`stateHash`, `setPerson`, `remoteBody`).
- No wall-clock time and no randomness inside the simulation.
- Node is at `C:\Program Files\nodejs\node.exe` (in Git Bash:
  `"/c/Program Files/nodejs/node.exe"`). Run tests from `web/`:
  `"/c/Program Files/nodejs/node.exe" --test "tests/*.test.js"`.
  Python for fixtures: `../.venv/Scripts/python.exe` from `web/` (Python 3.14
  with the lab's dependencies). Never print or read `../.env`.

## Python compatibility (`lab/py.js`)

The body's state hash and every string the model reads are produced by
Python's `round` and `json.dumps`. JavaScript differs in ways that matter:

| Python | JavaScript trap | Required |
|---|---|---|
| `round(x)` rounds half to even (`round(2.5) == 2`) | `Math.round(2.5) == 3` | `pyRound(x)` |
| `round(x, n)` rounds the exact binary value, ties to even (`round(2.25, 1) == 2.2`, `round(0.125, 2) == 0.12`) | `toFixed` breaks ties upward | `pyRoundN(x, n)` |
| `repr(1.0) == '1.0'`, `repr(1e-05) == '1e-05'`, `repr(1e16) == '1e+16'` | `String(1) == '1'`, `String(1e-5) == '0.00001'` | `floatRepr(x)` |
| `json.dumps` separators `", "` and `": "` | `JSON.stringify` has none | `pyDumps(value)` |
| an int and a float are different types | one Number type | key-based typing, below |
| `max(-0.0, 0.0)` is `-0.0` (first of equals) | `Math.max(-0, 0)` is `0` | `pyMax`, `pyMin` |
| `hashlib.sha256` is synchronous | `crypto.subtle` is async | a small synchronous SHA-256 |

```js
export function pyRound(x)            // Python round(x): nearest integer, ties to even
export function pyRoundN(x, n)        // Python round(x, n) for a float x, exactly
export function floatRepr(x)          // Python repr(float(x))
export function pyMax(a, b)           // Python max(a, b); pyMin likewise
export function pyMin(a, b)
export const FLOAT_KEYS               // Set of keys whose numbers are Python floats
export function pyDumps(value, { floatKeys = FLOAT_KEYS } = {})
                                      // Python json.dumps(value, ensure_ascii=False)
export function sha256Hex(text)       // hex SHA-256 of the UTF-8 bytes of text
```

Typing rule for `pyDumps`: every number found anywhere under a key in
`floatKeys` is written as a Python float (`floatRepr`); every other number is
written as an int when it is integral (exactly, any size: no `1e+21`) and as a
float otherwise. `FLOAT_KEYS` is `t`, `pos`, `actual`, `gap`, `person` and the
float fields of `Config` (`FULL_TRAVEL_S`, `MAX_TRACK_S`, `PULSE_S`,
`ABSENCE_GRACE_S`, `MAX_SESSION_MIN`). With that rule `pyDumps` reproduces
Python byte for byte for every log line, every wake message (`{"t": 12.0}`)
and every tool result (`{"ok": true, "t": 0.02}`, `sense` with
`"actual": [[0.0, ...` and `"color": [255, 255, 255]`). String escaping is
what `JSON.stringify` does for a string, which matches `ensure_ascii=False`.

What JavaScript cannot keep, and why it does not matter:

- **The model's own spelling of numbers in tool input.** `JSON.parse` turns
  `1.0` into `1`, so `args` in `call` lines, and the `tool_use.input` echoed
  back to the model within a turn, can read `1` where Python writes `1.0`.
  Integer-like keys come first, and integers past 2^53 lose digits. The body
  converts every number to a float before using it, so behaviour, hashes,
  `--verify` and `lab.analyze` are unaffected. The wiring test's `delay_s:
  r * 0.25` is logged as `0`, `1`, ... for the same reason.
- `-0` outside float keys is written `-0.0` (a Python int cannot be -0).
- `Infinity` can appear in a log (a model writing `1e400`); `pyLoads` reads
  it as Python's `json.loads` does, where `JSON.parse` would throw.
- `Math.cos` and the C library's `cos` differ in the last bit on about 2% of
  inputs. Hashes round to 9 decimals and heights are quantised, so no log
  has been affected; the tests measure the bound.

`SimBody.stateHash()` does not use `pyDumps`: it knows the type of every field
of the state (see `lab/simbody.py`: `tick`, colours and the pushed pin are
ints, everything else numeric is a float, rounded with `pyRoundN(x, 9)`), and
serialises it the way `json.dumps` would.

## The body (`lab/simbody.js` and below)

A line-by-line port of `display.py`, `nervous.py`, `contract.py`,
`simbody.py`. Same validation order, same error messages, same rounding.

```js
export class SimBody {
  constructor(config)
  tick                                  // completed steps
  get t()                               // config.timeOf(tick)
  setPerson(pos)                        // [row, col] floats, or null
  setPressed(pin)                       // [row, col] ints, or null
  call(name, args)                      // the contract; never throws
  step()
  snapshot()                            // {tick, t, rows, cols, target, actual, gap_max, color, person, pressed}
  stateHash()                           // 16 hex chars, identical to Python's state_hash()
}
```

Matrices are arrays of rows. `color`, `person`, `pressed` are arrays or null.

`Config` (`lab/config.js`): the fields of `lab/config.py` with the same names,
defaults and order (the order shows in the header line), plus `nPins`,
`maxStep`, `responseTicks`, `timeOf(tick)`, `tickOf(t)`, `toDict()`,
`static fromDict(d)`. `new Config(overrides)` takes an object of fields.

## The glue (`lab/world.js`, `lab/log.js`)

Ports of `world.py` and `log.py`. Differences come only from the browser:

- `World.events` is an Array used as a FIFO: the world pushes
  `["enter", t]`, `["leave", t]`, `["voice", t, text]`; the harness shifts.
- `World.remoteBody()` returns `{ call(name, args) }` whose `call` returns a
  Promise. The call is applied and logged on the next `world.tick()`, which
  resolves the Promise with the result. If the world is closed, or closes
  while the call waits, the Promise rejects with `WorldClosed`.
- `SessionLog` keeps the log in memory: `write(event)` (one `pyDumps` line,
  and the JSON-normalised copy to `feed`), `writeHeader(config, extra)`
  (`started_at` is local time, `YYYY-MM-DDTHH:MM:SS`), `text()` (the whole
  file, one line per event, `\n` endings), `fileName()`
  (`YYYY-MM-DD_HHMMSS.jsonl`, from when the log was created), `close()`.
- `parseLog(text)` returns the events of a JSONL file.
- `ReplayWorld(events)` and `verifyLog(events)` behave as in Python
  (`done`, `header`, `mismatches`, `callsReplayed`, `statesChecked`,
  `endTick`; `verifyLog` returns `{ok, ticks, seconds, calls, states,
  mismatches}`).

## The mind (`lab/mind.js`, `lab/model.js`, `lab/harness.js`)

`mind.js` exports `PROMPTS`, `TEXT`, `text(config, key)`,
`systemPrompt(config, note)`, `toolDefinitions(config)`,
`thinkingParam(config)`, and the note: `NOTE_KEY`, `loadNote(store)`,
`saveNote(config, store, args)` (returns `null` or the error text). `store`
is anything with `getItem`/`setItem` (the page passes `localStorage`). The
output must equal the Python functions exactly, checked against fixtures
exported from Python.

`model.js`:

```js
export class ModelError extends Error { constructor(message, retryable) }
export function requestBody(config, system, tools, messages)
    // the Messages API body the Python AnthropicModel sends:
    // {model, max_tokens, system, tools, messages, thinking, output_config: {effort}}
export class AnthropicModel {
  constructor(config, { apiKey } | { accessCode, endpoint = "/api/mind" }, { fetch, timeoutMs = 120000 } = {})
  name                                   // config.MODEL
  async respond(system, tools, messages) // -> {content, stop_reason, model, input_tokens, output_tokens}
  abort()                                // cancels a request in flight
}
export class ScriptedModel               // port of the Python wiring test; name "scripted"
```

With `apiKey` the browser calls `https://api.anthropic.com/v1/messages`
directly (headers `x-api-key`, `anthropic-version: 2023-06-01`,
`anthropic-dangerous-direct-browser-access: true`). The key goes nowhere
else, is never logged and never stored. With `accessCode` it posts the same
body to `api/mind.js` with header `x-lab-access-code`; the server checks it
and forwards with the owner's key. The response JSON is the API's own, and
content blocks are echoed back unchanged within a turn. Errors are sorted as
in Python's `wrap_error`: network failure, 429, 408, 409 and 5xx are
retryable; a timeout and any other 4xx are not. The message keeps the API's
error text, never the key.

`harness.js`: `new Harness(world, model, config, { noteStore = null,
retryWaits = [2, 4, 8], sleep })`, `start({ runLoop = true })`,
`async step()` (true if a turn ran), `async stop(reason = "window_closed")`.
`sleep(seconds)` takes seconds, like Python's waits. The mind loop is
`while (!ended && !stopped) { if (!(await step())) await sleep(0.02) }`.
Every decision is made from `world.t` and `world.events`, exactly as in
`harness.py`; the log lines it writes are the same, field for field
(`tests/fixtures/harness.json` is Python's output for the same scenarios).

`stop()` aborts a request in flight, waits up to 1 s for the turn to log its
end (Python's `join(timeout=1)`), then writes `close`; the page awaits it.
Python cannot cancel a request, so there the turn may log an `api_error` or
one more retry; here the turn ends with `skipped: false` and nothing more is
sent. In later-days mode without a `noteStore` the note lives in memory for
the session. The note's line endings are normalised on reading (`\r\n` and
`\r` become `\n`), as Python's text files do. `NOTE_KEY` is `"ai-dan.note"`.

`SessionLog` takes `{ feed, now }`; `now` is the clock for `started_at` and
the file name, so tests can fix it.

## The page (`index.html`, `lab/render.js`, `lab/app.js`)

A port of `render.py` and `app.py` to one full-window 2D canvas, plus a start
screen. The honesty rule from `render.py` holds word for word: every visual
property of a pin comes from that pin's real height and the body's colour,
and from nothing else.

Modes, as on the desktop: `replay` (the bundled first session, or a log file
the visitor opens or drops on the page), `live` (a mind, with the visitor's
key or the host's access code), `dryrun` (the wiring test, labelled "not an
AI" wherever the desktop labels it). A live or dry-run session can be
downloaded as its JSONL log at any time and when it ends.

The loop is the desktop's: fixed 20 ms simulation steps kept in line with
the wall clock by `requestAnimationFrame`, at most 10 steps per frame, a
longer stall dropped rather than replayed (`app.py`). When the tab is hidden
the person has left the room. A live session keeps running on a timer
instead, which browsers wake as seldom as once a minute, so each wake
catches simulation time up with the wall clock, up to 60 s at a time. A
replay pauses.

`GET /api/mind` answers `{"available": true|false}`: whether the host has
turned on the access-code mode. When it is off, or the request fails, the
start screen offers only the visitor's own key.

## Hosting

Vercel, free tier, project Root Directory `ai-dan/web`, no build step.
Static files are served as they are; `api/mind.js` is the only function.
Every push to `main` deploys to production; other branches get previews.

The access-code mode is off unless the owner sets both `ANTHROPIC_API_KEY`
and `LAB_ACCESS_CODE` in the Vercel project. The function only forwards
requests that are this lab's:

- The system prompt must be the lab's, optionally followed by a note of up
  to `NOTE_MAX_CHARS` in later-days mode.
- The model, `max_tokens`, thinking, effort and tools always come from
  `lab/config.js` and `lab/mind.js` on the server, whatever the browser sends.
- Every message block is rebuilt from the fields the harness writes. User
  text must be a wake (`{"t": ...}` with at most 20 heard lines of 200
  characters), and a tool result must be a body answer (a JSON object with
  `t`). Images, documents and cache settings never get through.
- Wrong codes are counted per caller and slowed after 10 in 10 minutes, per
  function instance.
- When the browser gives up, the request to the API is cancelled.

Anyone who holds the code can still spend the key, one lab-shaped request at
a time: share it only with people you trust, and give the key a spend limit
in the Anthropic Console. `tests/api_session.test.js` runs whole sessions
through the function to show the harness's own requests always pass.
