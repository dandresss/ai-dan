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
    render.js       ui       port of lab/render.py to a 2D canvas
    app.js          ui       the page: start screen, input, the fixed-step loop
  tests/            each owner: `<module>.test.js`, run with `node --test`
    fixtures/       generated from the Python lab by scripts kept next to them
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
`async step()` (true if a turn ran), `stop(reason = "window_closed")`. The
mind loop is `while (!ended && !stopped) { if (!(await step())) await
sleep(20 ms) }`. Every decision is made from `world.t` and `world.events`,
exactly as in `harness.py`; the log lines it writes are the same, field for
field. `stop()` aborts a request in flight; anything that arrives after the
close is discarded, as in Python.

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
the person has left the room.

`GET /api/mind` answers `{"available": true|false}`: whether the host has
turned on the access-code mode. When it is off, or the request fails, the
start screen offers only the visitor's own key.

## Hosting

Vercel, free tier, project Root Directory `ai-dan/web`, no build step.
Static files are served as they are; `api/mind.js` is the only function.
Every push to `main` deploys to production; other branches get previews.

The access-code mode is off unless the owner sets both `ANTHROPIC_API_KEY`
and `LAB_ACCESS_CODE` in the Vercel project. The function only forwards
requests that are this lab's: the system prompt, tools, model and settings
must be exactly what `lab/mind.js` and `lab/config.js` produce.
