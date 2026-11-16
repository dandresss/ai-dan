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
    camera.py          lead     the fixed 3D view: projection, the floor under the pointer, picking
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

## The 3D view (`lab/camera.py`)

F3, and a "3D view" button on the page, switch the room between the top view
and a fixed 3D view, to see at a glance how high each pin stands. The camera
stands in front of the body, beyond the last row and centred on the columns,
and looks down at the centre of the grid from 50° above the plate, where a
person at the display would stand. It never moves: no orbit, no zoom. Switching
views is instant, with no animated camera, because nothing on screen may move
unless the body's state says so. The top view stays the default, and the
instrument for the experiment.

`lab/camera.py` is the arithmetic, with no pygame. `web/lab/camera.js` is its
line-for-line port, checked against `web/tests/fixtures/camera.json`, which
`web/tests/fixtures/make_camera_fixtures.py` writes from the Python.

```python
class Camera:
    def __init__(self, rows, cols, center, height, max_width)
        # fitted so the body (plate, and pins at full height) is `height` px tall
        # on screen, narrower if it would be wider than max_width, centred on center
    def project(self, x, y, z) -> (sx, sy)     # world (column, row, height units) -> px
    def floor(self, px) -> (row, col)          # the floor point under a pixel
    def order(self) -> [(r, c)]                # drawing order: back row first, outside in
    def faces(self, r, c, h) -> [(kind, quad)] # faces the camera sees, in drawing order;
                                               # kind: "left", "right", "front", "top"
    def plate(self) -> (top_quad, front_quad)
    def bounds(self) -> (x, y, w, h)
    def covers(self, px, r, c, h) -> bool
    def pick(self, px, heights, hold=None) -> (r, c) | None
```

Constants, the same in both files: `ELEVATION_DEG` 50, `DISTANCE` 2.6 grid
sides, `RISE` 1.8 (a pin at height 1 stands 1.8 pin widths tall), `PIN` 0.78,
`PLATE_MARGIN` 0.35, `PLATE_DEPTH` 0.22, `FAR` 4.

### Layout

`layout(size, panel, rows=8, cols=8, view3d=False)` (page:
`layout(size, panel, rows = 8, cols = 8, view3d = false)`) computes everything
as before (room, grid, pitch, panel, u: the chrome is placed from them in both
views) and adds `camera`, None in the top view:

```python
camera = Camera(rows, cols, grid.center, grid.height + int(pitch * 0.7), room.width - pitch)
# page, compact layout included:
# new Camera(rows, cols, [grid.cx, grid.cy], grid.h + intOf(pitch * 0.7), room.w - pitch)
```

So the 3D body is as tall on screen as the top view's plate, and centred where
the plate is. `Layout` also gains `heights`: the real heights, `[row][col]`,
the frame was drawn with. `draw()` sets it; it is None before the first frame.
The methods dispatch on the camera:

| Method (page: camelCase) | Top view | 3D view |
|---|---|---|
| `to_pin_units(px)` | as before | `camera.floor(px)` |
| `to_pixels(pos)` | as before | `camera.project(pos[1], pos[0], 0)` |
| `pin_at(px, rows, cols, hold=None)` | as before; `hold` ignored | `camera.pick(px, heights or [], hold)` |
| `height_of(pin)` (new) | the module's `height(heights, r, c)` | the same |
| `touch(px, hold=None, rows, cols)` (new) | below | below |

`touch` is what a held button presses now: `pin = pin_at(px, rows, cols,
hold)`; None if there is no pin; `hold` itself if it is on the same pin;
otherwise `(pin, height_of(pin))`. In the top view it names the same pin as
`pin_at`, so nothing changes there.

### The person and a press

- **The person** is the floor point under the pointer (`to_pin_units`). It
  never depends on the pins' heights, so the body's own motion can never move
  the person the mind senses.
- **A press** goes to the pin drawn under the pointer: the nearest pin whose
  outline contains it, or, over a gap, the cell of the floor point, as in the
  top view.
- **Only the person moves a press.** The press is chosen when the button goes
  down and again only when the pointer moves. While the pointer is still, the
  press stays as it is, whatever the body does, so the body's own motion can
  never start, move or end a touch. When the pointer moves, the press stays on
  its pin while the pointer is inside the pin's outline as it stood when the
  press began, or over that pin's own cell of the floor (`Camera.pick` with
  `hold`). So a tremble of the hand does not hand the press to a pin that
  sank or rose meanwhile; moving off the pin does.
- The desktop `App` keeps `self.hold`, None or `((row, col), height)`, and
  `self.hold_at`, the mouse position it was chosen at. Each tick, `_pressed()`
  calls `self.layout.touch(self.mouse, self.hold)` only if the mouse is not
  where it was, and returns the held pin; both reset when the button is up and
  when it goes down. The page's `Pointer` does the same in `pressed(lay, rows,
  cols)` with `hold` and `holdAt`, reset on `down`, `up` and `leave`. Both are
  called once per tick.
- F3 held down repeats; the view switches once per press of the key.
- Known consequences:
  - While a tall pin's top is pressed, the person's floor point lies behind
    that pin, by about two rows when it is fully raised (2.07 at most). For the
    back row it lies behind the body, at a row below 0. In the top view the two
    always agree.
  - The outline a press keeps includes the parts nearer pins hide, so dragging
    off a pin moves the press a little later than the picture suggests.
  - The log does not say which view was used. Sessions for the experiment use
    the top view.
  - A recorded visitor far in front of the body (about 36 rows on an 8×8 grid)
    lands beyond the camera, far off the screen, and is not drawn.

### Drawing

When `lay.camera` is set, `draw_body` (page: `drawBody`) draws the 3D body.
The honesty rule holds word for word: every visual property of a pin comes from
its real height and the body's colour, and from nothing else. Which pin hides
which follows from the real heights alone.

1. **The plate**, from `camera.plate()`: the top filled with `PLATE` and
   outlined 1 px with `PLATE_EDGE`; the front edge filled with
   `mix(PLATE, black, 0.45)`.
2. **Glow**, added to the plate as in the top view: for each pin with
   h > 0.02, `level = round(h ** 1.5 * 20) / 20` (Python's round), colour
   tint × 0.30 × level, a radial glow centred on `project(c + 0.5, r + 0.5, 0)`
   whose width and height are those of the projected 2.4 × 2.4 square around
   that point: an ellipse lying on the plate.
3. **Pins**, in `camera.order()`. Each face from `camera.faces(r, c, h)` is
   filled with the pin's top-view colour `face = pin_face(h, tint)`, shaded by
   a fixed light from the upper left: top `face`, front
   `mix(face, black, 0.42)`, left `mix(face, black, 0.30)`, right
   `mix(face, black, 0.55)`. The top is outlined 1 px with the top view's edge
   colour, `mix(face, white, 0.05 + 0.2 * h)`. No shadows. Each platform covers
   the hairline seams between a pin's own faces however it needs to.
4. **The person** as before, after the body: live at the pointer; in a replay,
   the ghost at `to_pixels(snap.person)`, the floor point.

### Keys, buttons, words

- F3 toggles `view.view3d` (desktop `View.view3d: bool = False`; page
  `makeView` field `view3d: false`).
- Help, after the F2 row: `F3` "3D view: see how high each pin stands; F3
  again for the top view". The page's touch help gains `3D view` "see how high
  each pin stands".
- The desktop's status line hints: `Tab observer    F1 help    F3 3D view`
  (panel closed) or `F1 help    F3 3D view` (open). In the 3D view the hint
  reads `F3 top view`. The `__main__` epilog lists `F3 3D view` after F2.
- The page: a button `<button type="button" data-act="view3d"
  aria-pressed="false" aria-keyshortcuts="F3">3D view</button>` right after
  Observer, whose `aria-pressed` follows the view; `keyAction` answers
  `"view3d"` for F3. The page remembers the choice for the rest of the visit:
  every new view (a session, Watch again, the replay behind the start card)
  starts in the view last chosen. Nothing is stored. The start screen has the
  3D view too: with the card beside the body, the button alone, where it
  stands in the room; F3 at any width.
- `lab/shot.py` gains 3D scenes.

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
