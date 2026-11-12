# Harness: beta spec

The loop that wakes the mind, hands it its tools and records everything. There is no task to complete: the agent exists in time and the world happens to it.

Related: `body-contract.md` defines the body's tools; `mind.md` defines the prompt, memory across sessions and the success criterion.

## Scope

- **Includes:** the two-loop architecture, session start and end, what wakes the agent, what it receives, the anatomy of a turn, in-session memory and logging.
- **Excludes:** the prompt text and memory across sessions (`mind.md`), and the body's behavior (`shape-display.md`, `nervous-system.md`).

## Parameters

| Name | Value | Description |
|---|---|---|
| `PULSE_S` | 12 | Seconds between wakes while someone is present, counted from the end of the previous turn |
| `ABSENCE_GRACE_S` | 2 | Seconds outside the window before the person counts as gone |
| `MAX_TOOL_CALLS` | 8 | Tool calls per turn |
| `MAX_TURNS` | 40 | Turns per session |
| `MAX_SESSION_MIN` | 15 | Minutes per session |
| `MEMORY_FULL_TURNS` | 6 | Recent turns kept in full |
| `MAX_TOKENS` | 1024 | Output cap per model response |
| `MODEL` | configurable | A current Claude Sonnet model; confirm the exact identifier in the documentation when implementing |

The API key lives in a local `.env` file, outside the repository.

## Architecture

- **Two loops:** the body runs at 50 ticks per second on the main thread; the mind runs on a second thread. The body never pauses while the model thinks.
- **Two queues:** tool calls go from mind to body and apply on the next tick; events go from body to mind.
- **One interface:** the harness talks to a `Body` object offering `play`, `stop`, `sense` and `set_color`. The simulator implements it today; the board will later.
- **No MCP in the beta:** the body is a direct in-process call. MCP comes in when the body is a separate device.

## Session

- **Start:** when the person first arrives, that is when the mouse enters the window. No model call happens before that.
- **End:** on reaching `MAX_TURNS` or `MAX_SESSION_MIN`, or when the window closes.
- **Afterwards:** the harness stops waking the agent and the body stays as it is. Nothing stops by itself.

## What wakes the agent

| Source | When |
|---|---|
| Arrival | The mouse enters the window |
| Departure | The mouse has been outside the window for `ABSENCE_GRACE_S` |
| Voice | The person types a line and presses Enter |
| Pulse | Every `PULSE_S` while someone is present |

- **Nobody there, no calls:** the mind sleeps and the body carries on with whatever was left looping.
- **Farewell:** a departure produces one last wake. Then the pulse stops until someone returns.
- **Touch does not wake it:** it stays in the deviation trace and the agent finds it on its next `sense`.

## Wake message

The message is bare: only the time, plus whatever the person said.

```
{"t": 0.0}
{"t": 31.5, "heard": ["hello"]}
```

- It carries no reason and no body reading. To know what is happening, the agent has to call `sense`.
- An arrival, a departure and a pulse look the same in the message.
- **Known risk:** nothing in the harness guarantees the agent's first act is to sense. If it does not call `sense`, it never learns someone is there. The prompt carries that weight.

## Anatomy of a turn

1. The harness assembles the conversation: prompt, history under the memory policy, and the wake message.
2. It calls the model with the available tools.
3. If the response contains tool calls, it runs them in order against the body and returns the results.
4. It repeats from step 2 until the model calls no tools or `MAX_TOOL_CALLS` is reached.

Rules:

- **The model's text is private:** it is never shown to the person. It goes to the log as monologue.
- **Events during a turn:** queued and merged into a single wake when the turn ends. Voice lines accumulate in `heard`.
- **Cap reached:** pending calls are executed and the turn ends without another model call. Their results travel with the next wake message.
- **API failure:** retried with growing waits up to three times. If it persists, the turn is skipped and logged. The body is unaffected.

## Available tools

- The body's four: `play`, `stop`, `sense` and `set_color`.
- `remember`, only when memory across sessions is on. See `mind.md`.

## In-session memory

- The last `MEMORY_FULL_TURNS` turns are sent in full.
- In earlier turns the agent's text and its calls are kept, and each `sense` result is replaced by a marker: `{"t": 14.1, "faded": true}`.
- The agent remembers its conclusions, not every reading.

## Log

One file per session, one line per event, each with simulation time.

- **Header:** every parameter from every spec, the prompt version and the model.
- **Person inputs:** mouse position when it changes, clicks and voice lines.
- **Mind:** every wake, the model's text, every tool call with its return, and token usage.
- **Close:** reason for ending, number of turns and total tokens.

With calls and inputs logged, a whole session can be replayed in the simulator without calling the API. That serves video capture and the criteria in `mind.md`.

## Cost

Each turn is one or more model calls, and the history is resent on each. The cost knobs are `PULSE_S`, `MAX_TURNS` and `MEMORY_FULL_TURNS`. Real spend is measured from the token usage in the log.

## Acceptance criteria

1. No model call happens before the person arrives.
2. The body keeps running at 50 ticks per second while a model call is in flight.
3. The pulse only fires with someone present, and after a departure there is exactly one more wake.
4. A turn stops at 8 tool calls.
5. A line typed during a turn appears in the `heard` of the next wake.
6. A session replayed from its log, without the API, produces the same body states.
7. The session ends at 40 turns or 15 minutes.

## Out of the beta

- Touch waking the agent.
- Triggers and reflexes.
- Voice through a microphone.
- MCP and the body in another process.
- Prompt caching and streamed responses.

## Defaults to review

Proposed and not yet confirmed. Worth revisiting before implementing:

- The bare wake message, with its known risk.
- Every value in the parameter table.
- The farewell wake when the person leaves.
