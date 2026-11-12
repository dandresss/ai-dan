# Body contract: v0

The interface between the agent and its body. It is the same for the simulator and for the future board: the harness should not notice the difference. The simulated body is described in `shape-display.md`.

## Principles

- **Small surface:** four tools.
- **Verbs, not limits:** descriptions say what each tool does. The body's limits appear in nothing the agent reads.
- **Honest answers:** every return carries the time, and `sense` returns the real state, not the ordered one.

## What the agent knows

| It is told | It is not told |
|---|---|
| That it has four tools and what each does | The size of the grid |
| The shape of a track: pins, keyframes, options | Top speed, height levels, response delay |
| That a pin is named `[row, column]` | That it can be touched |
| | What `gap` and `person` mean |
| | Caps on tracks and keyframes |

The first `sense` reveals the grid size. Everything else is discovered by acting.

## Tools

### `play`

Visible description: "Move parts of your body over time."

Input: `tracks`, a list. Each track has:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `pins` | `"all"` or a list of `[row, column]` | required | Which pins follow this track |
| `keyframes` | list of `[second, height]` | required | First at second 0, increasing times, heights 0 to 1 |
| `loop` | yes or no | no | Repeat when finished |
| `delay_s` | number | 0 | Wait before starting |
| `ease` | `"smooth"` or `"linear"` | `"smooth"` | How one keyframe joins the next |

Behavior:

- **Replace per pin:** a new track replaces what its pins were doing. Pins not mentioned carry on.
- **During the wait:** the pin holds the ordered height it had when the track arrived.
- **Ending without loop:** the pin holds the last keyframe's height.
- **Looping:** it returns to the first keyframe. If the last and first heights differ, the speed limit absorbs the jump.
- **Heights outside 0 to 1:** clipped without error. The body simply goes no further.
- **Same pin in two tracks of one call:** the last one wins.

Return: `{"ok": true, "t": 12.4}`

### `stop`

Visible description: "Stop the movement."

Input: `pins`, optional, same format as in `play`. Without it, every pin stops.

Behavior: each pin holds the ordered height it had at that instant.

Return: `{"ok": true, "t": 15.0}`

### `sense`

Visible description: "Sense your body and what is around you."

Input: none.

Return:

```
{"t": 14.1,
 "actual": [[0.52, 0.52, ...], ...],
 "gap":    [[0.02, 0.02, ...], ...],
 "person": [3.2, 9.1],
 "color":  [255, 255, 255]}
```

| Field | Meaning |
|---|---|
| `t` | Seconds since the session began |
| `actual` | 8×8 matrix of real pin heights, two decimals |
| `gap` | 8×8 matrix with the deviation trace, two decimals |
| `person` | The person's position in pin units, or `null` if nobody is there |
| `color` | Current global color |

**Deviation trace.** A pin's deviation is the absolute difference between its latest ordered height and its real height. The trace is that pin's largest deviation since the previous `sense`. Each `sense` returns it and resets it to zero.

Deviation is measured against the latest order, not the one already delayed by the actuator. A moving body therefore shows a small, even trace: its own lag.

### `set_color`

Visible description: "Change your color."

Input: `rgb`, three integers from 0 to 255.

Return: `{"ok": true, "t": 16.2}`

## Errors

Format: `{"ok": false, "t": 12.4, "error": "message"}`

- A call with an error changes nothing in the body. It is rejected whole.
- The message says what was wrong in plain words, without revealing unrelated limits.

| Case | Message |
|---|---|
| Pin outside the grid | "That point does not exist in your body." |
| More than 16 tracks | "That is too many movements at once." |
| More than 16 keyframes, or a keyframe or wait beyond 600 s | "That movement is too long to remember." |
| Fewer than 2 keyframes, first keyframe not at second 0, or times not increasing | "That movement cannot be understood." |
| Invalid color | "That color cannot be understood." |

## General rules

- **Wakes flat:** at session start every pin is at height 0 and still. Nothing moves until the agent orders it.
- **Real time:** the body does not pause while the agent thinks. There is no wait tool; the `t` in each return is the agent's clock.
- **Voice does not pass through here:** what the person says arrives as a message, handled by the harness.
- **The log leaves no trace:** the lab log reads body state without resetting the deviation trace. Only the agent's `sense` resets it.

## Internal caps

| Name | Value | Reason |
|---|---|---|
| `MAX_TRACKS` | 16 | Board memory |
| `MAX_KEYFRAMES` | 16 | Board memory |
| `MAX_TRACK_S` | 600 | Firmware stores time in 16 bits; applies to the last keyframe and to `delay_s` |

## Known consequences

These follow from the contract and are not told to the agent:

- **Its own lag can be felt:** while moving, the trace is small and even across the moving pins.
- **A sudden jump leaves a large trace:** ordering a change faster than the pin can move creates a self-made deviation that can mask a simultaneous touch.
- **A pin at height 0 feels nothing:** pushing it does not move it. A flat body is numb.
- **The trace has no time:** it says where and how much, not when or how often.

## Acceptance criteria

1. A track with `"all"`, three keyframes and `loop` makes `actual` rise and fall across successive `sense` calls.
2. A brief touch between two `sense` calls shows in the `gap` of the next one and no longer in the one after.
3. A `play` on a subset does not alter the motion of the rest.
4. An invalid call returns an error and leaves the body exactly as it was.
5. No parameter or return depends on the simulator: the same harness must be able to talk to the board.

## Out of v0

- A wait tool.
- Gradual blending between one motion and the next.
- Spatial shortcuts for waves, such as phase per row or column.
- Triggers: rules the body runs by itself on a stimulus.
- Named gestures stored in the body.
- Per-pin color and an image in `sense`.

## Closed decisions

- **Language:** visible descriptions and error messages are in English in this package, matching the prompt. See `mind.md`.
