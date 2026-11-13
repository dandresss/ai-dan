# Lab architecture: the team contract

This is the first stage of "A body to wake up in": the virtual lab. The five
specs in the parent folder (`../README.md`, `../shape-display.md`,
`../body-contract.md`, `../nervous-system.md`, `../harness.md`, `../mind.md`)
are the source of truth for behaviour. This file fixes only what the specs
leave open: module boundaries, signatures, the log format and a few decisions.

The demo is an invitation. It must run with one command, look alive, and stay
honest: nothing on screen may suggest the body does something the mind did
not order.

## Layout and ownership

```
ai-dan/
  ARCHITECTURE.md      lead
  pyproject.toml       lead     dependencies; `uv run` reads it
  main.py              lead     entry point: `uv run python main.py`
  lab/
    config.py          lead     every parameter from every spec
    body.py            lead     Body protocol, Snapshot, ThreadedBody
    log.py             lead     SessionLog, Feed, read_log, new_log_path
    world.py           lead     World (live glue), ReplayWorld, verify_log
    display.py         body     shape display dynamics
    nervous.py         body     tracks -> ordered heights
    contract.py        body     validation, tool behaviour, error messages
    simbody.py         body     SimBody: the three above behind one object
    mind.py            harness  prompt, tool definitions, the note
    model.py           harness  Model protocol, AnthropicModel, ScriptedModel, make_model
    harness.py         harness  the mind loop: wakes, turns, memory, limits
    render.py          ui       drawing (pure function of view state)
    app.py             ui       window, input, main loop
    __main__.py        ui       command line
    shot.py            ui       headless screenshots
    analyze.py         analysis success criterion from logs
  tests/               each owner tests their own modules
  sessions/            session logs (git-ignored)
```

Rules for the team:

- Edit only the files you own. If a lead file blocks you, work around it and
  say so in your report; do not change it.
- Run everything through uv from this folder: `uv run python main.py`,
  `uv run pytest`. uv keeps the environment in `.venv` and the exact versions
  in `uv.lock`.
- Dependencies are `anthropic`, `pygame-ce` (imported as `pygame`),
  `python-dotenv`, `pytest`. Nothing else, and no numpy: 64 pins do not need it.
- Plain, readable code. Short modules. Comments only where the reason is not
  obvious. People will read this to decide whether to join.
- No wall-clock time and no randomness inside the simulation.

## Time

- The clock starts when the person first arrives. Until then `World.tick` does
  nothing, so `t` is seconds since the session began, as the contract says.
- `body.tick` counts completed steps. Simulation time is `t = tick / TICK_HZ`,
  reported everywhere as `config.time_of(tick)` (two decimals).
- A call applied while `body.tick == k` is stamped `t = k / 50`. The `step()`
  that follows computes ordered heights for that same time and then advances
  to `k + 1`. So a `play` is in motion within one tick of arriving.
- The window keeps simulation time aligned with the wall clock by running a
  fixed 20 ms step. The mind thread never touches the body directly.

## Conventions

- Matrices are `[row][column]`, `(0, 0)` top left.
- The person's position is `(row, column)` in pin units, that is `(y, x)`: the
  same order as a pin's name. It can lie outside 0..8.
- Tool results are plain JSON-ready dicts (lists, not tuples).

## The body (`lab/simbody.py`)

```python
class SimBody:
    def __init__(self, config: Config): ...
    tick: int                       # completed steps
    t: float                        # config.time_of(tick)
    def set_person(self, pos: tuple[float, float] | None) -> None
    def set_pressed(self, pin: tuple[int, int] | None) -> None
    def call(self, name: str, args: dict | None = None) -> dict   # the contract; never raises
    def step(self) -> None          # one tick: nervous system -> display
    def snapshot(self) -> Snapshot  # lab view; never resets the trace
    def state_hash(self) -> str     # short hex digest of the full body state
```

- `call` dispatches `play`, `stop`, `sense`, `set_color` and returns exactly
  the shapes in `body-contract.md`. Input comes straight from a language
  model, so anything can arrive: wrong types, missing fields, extra fields.
  Bad input gets the contract's error shape and changes nothing.
- `sense` is the only thing that resets the deviation trace.
- `state_hash` covers tick, targets, real heights, trace, colour and per-pin
  track state, with floats rounded to 9 decimals, so replays can be checked.
- Single-threaded and deterministic: same calls and inputs at the same ticks
  give the same states, always.

## The glue (`lab/world.py`, already written: read it)

`World.tick(person, pressed)` is one simulation tick: person and touch first,
then the mind's queued calls in arrival order, then `body.step()`.
`World.say(text)` is the person's voice. `World.remote_body()` gives the mind
thread a `Body` whose calls are applied on the next tick. `World.events` is the
queue the harness listens on: `("enter", t)`, `("leave", t)`, `("voice", t, text)`.
`World.turn` is a label the harness sets; it is stamped on logged calls.
`World.feed` is the live event feed the window reads.

`ReplayWorld(events)` has the same surface (`tick`, `snapshot`, `feed`,
`config`, `t`, plus `done`, `header`, `mismatches`) and re-runs a log with no
API. `verify_log(path)` does that headlessly.

## The log (`lab/log.py`)

One JSON object per line. Every event has `type` and `t` (simulation seconds).
The file order is the order things happened.

| type | written by | fields |
|---|---|---|
| `header` | harness (or `__main__` when there is no mind) | `version`, `started_at`, `config`, `prompt_version`, `prompt` (the exact system prompt sent), `model`, `tools` (names), `memory_enabled`, `mind` (`"live"`, `"scripted"` or `"none"`) |
| `person` | world | `tick`, `pos` (`[row, col]` or `null`) |
| `press` | world | `tick`, `pin` (`[row, col]` or `null`) |
| `voice` | world | `tick`, `text` |
| `call` | world, for body tools | `turn`, `tick`, `name`, `args`, `result` |
| `call` | harness, for calls that never reach the body (`remember`, calls past the cap) | `turn`, `name`, `args`, `result`, no `tick` |
| `state` | world | `tick`, `hash` |
| `wake` | harness | `turn`, `reasons` (any of `arrival`, `departure`, `voice`, `pulse`), `message` (exactly what the model was sent) |
| `thought` | harness | `turn`, `kind` (`text` or `thinking`), `text` |
| `usage` | harness, one per model response | `turn`, `model`, `stop_reason`, `input_tokens`, `output_tokens` |
| `api_error` | harness | `turn`, `attempt`, `error` |
| `turn_end` | harness | `turn`, `tool_calls`, `capped`, `skipped` |
| `close` | harness | `reason` (`max_turns`, `max_minutes`, `window_closed`), `turns`, `input_tokens`, `output_tokens` |

`reasons` is for the lab only. The model never sees it: the wake message is
bare, as `harness.md` says.

## The mind side

```python
# lab/model.py
@dataclass
class ModelResponse:
    content: list        # content blocks, to be echoed back unchanged within the turn
    stop_reason: str
    model: str           # the model that actually answered
    input_tokens: int
    output_tokens: int

class Model(Protocol):
    name: str
    def respond(self, system: str, tools: list[dict], messages: list[dict]) -> ModelResponse: ...

def make_model(config: Config) -> Model | None    # None when no credentials are found
class AnthropicModel: ...                          # the real one
class ScriptedModel: ...                           # wiring test only, see below

# lab/mind.py
def system_prompt(config: Config, note: str | None) -> str
def tool_definitions(config: Config) -> list[dict]

# lab/harness.py
class Harness:
    def __init__(self, world, model: Model, config: Config, note_path: Path | None = None): ...
    def start(self) -> None                 # writes the header, starts the mind thread
    def stop(self, reason: str = "window_closed") -> None   # idempotent; writes `close`; joins
```

The window knows the mind only through `world.feed`: `wake` means awake,
`turn_end` asleep, `close` ended.

Shutting down: `world.close()` first, then `harness.stop()`, then
`log.close()`. Closing the world releases any call the mind is waiting on.

## Decisions the specs left open

These are settled for this stage. Each is listed in the README so the author
can overturn it.

1. **Model.** `claude-sonnet-5-5`, adaptive thinking with summarized display,
   effort `low`, no beta features, no forced tool choice. Thinking cannot be
   switched off on this model and counts toward the output cap, so
   `MAX_TOKENS` is 4096 rather than the spec's 1024.
2. **Monologue.** Both the model's text blocks and its non-empty thinking
   summaries are logged as `thought` events.
3. **Memory and thinking blocks.** Within a turn the assistant content is
   echoed back unchanged. When a turn is over it is settled: each non-empty
   thinking block becomes a text block with the same words, in place; empty
   ones are dropped. This keeps "the agent's text and its calls" as
   `harness.md` asks, and keeps the history valid when older `sense` results
   fade (the API rejects replayed thinking blocks once earlier turns change).
4. **Calls past the cap.** A turn stops at `MAX_TOOL_CALLS`. Calls beyond it
   in the same response are not run; each gets
   `{"ok": false, "t": ..., "error": "That is too much for one moment."}`.
5. **Tool schemas say shapes, not limits.** Field names and types only. No
   height range, no grid size, no caps.
6. **Refusals.** A `refusal` stop is logged and the turn is skipped. No
   automatic fallback to another model: a session is one model throughout.
7. **`sense.person`** is `[row, column]` with one decimal.
8. **`--dry-run`** runs the whole loop with `ScriptedModel`, a fixed and
   deliberately mechanical test pattern, labelled on screen as not an AI. It
   exists to check the wiring without spending tokens. It is never the
   experiment.
9. **The observer panel** (the mind's thoughts and calls) is hidden until the
   person presses Tab, because `harness.md` says the monologue is never shown
   to the person.
10. **A response cut off at the output cap.** Its last call may be half
    written and still parse, so none of that response's calls are run. Each
    gets the same answer as a call past the cap, and the turn ends.
11. **A wake after an unanswered turn** (API failure, refusal) joins the user
    message that is still waiting, so roles always alternate.
12. **Retries.** One attempt plus three retries, waiting 2, 4 and 8 seconds.
    Rate limits, connection errors, 408, 409 and 5xx are retried. Timeouts
    (120 s) and other 4xx are not: the turn is skipped.
13. **Recent turns in full.** `MEMORY_FULL_TURNS` counts finished turns; the
    turn in progress is always in full.
14. **What the analysis counts.** Only sessions with a live mind, memory off,
    at least one answer from the model, and an end at `max_turns` or
    `max_minutes`. Counted sessions are grouped into batches by identical
    config, prompt and model, and the reading from `mind.md` is given only for
    a batch of exactly 10. The 30 seconds of condition 4 must be in the log,
    counted from when each pin's track actually starts.
