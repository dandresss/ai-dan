# Shape display: beta spec

The simulated body for the first version of the virtual lab: what it is, how it moves, and what state it exposes.

## Scope

- **Includes:** pin grid, motion dynamics, touch, the person's presence, color and on-screen rendering.
- **Excludes:** the agent's tools (`body-contract.md`), trajectory playback (`nervous-system.md`), prompt and memory (`mind.md`).
- **Boundary:** every tick the display receives one ordered height per pin.

## Parameters

| Name | Value | Description |
|---|---|---|
| `GRID_ROWS`, `GRID_COLS` | 8, 8 | A grid of 64 pins |
| `LEVELS` | 64 | Distinguishable height levels |
| `FULL_TRAVEL_S` | 0.5 | Seconds to travel from 0 to 1 |
| `TICK_HZ` | 50 | Simulation ticks per second |
| `RESPONSE_MS` | 80 | Actuator response delay between a change in ordered height and the pin starting to follow it |
| `DEFAULT_COLOR` | (255, 255, 255) | Initial global color, neutral white |

All are configurable. The response delay is fixed while there is no noise. It does not model the network.

## Geometry

- A pin is `(row, column)`, with `(0, 0)` at the top left. Linear index is `row * 8 + column`.
- Positions are measured in pin units: the grid spans 0 to 8 on each axis.
- The window leaves a margin around the grid for the space surrounding the display.

## Initial state

Every pin starts at height 0, with a zero deviation trace and white color. The body starts flat.

## Per-pin state

| Field | Range | Meaning |
|---|---|---|
| `target` | 0 to 1 | Ordered height |
| `actual` | 0 to 1 | Real height |
| `pressed` | yes or no | The person is pushing it (internal, never exposed) |
| `gap_max` | 0 to 1 | Deviation trace: largest difference between `target` and `actual` since the agent last read it |

Real height is stored as a continuous value and reported quantized to 64 levels. Ordered height is quantized on arrival.

## Dynamics

1. The ordered height at time `t` starts being followed at `t + RESPONSE_MS`.
2. Each tick, `actual` moves toward `target` by at most `1 / (FULL_TRAVEL_S * TICK_HZ)`, that is 0.04 per tick.
3. If the remaining distance is smaller than that step, `actual` lands exactly on `target`.
4. Heights outside 0 to 1 are clipped.

Intended consequence: wide gestures are slow and fast gestures are small. A full-range oscillation tops out at 1 cycle per second; one at 10% of the range reaches 10.

## Deviation trace

- Each tick, a pin's deviation is the absolute difference between its latest ordered height and its real height.
- It is measured against the latest order, not the one already delayed by the actuator. A moving body therefore shows a small, even deviation.
- `gap_max` keeps the largest deviation since the agent's last read. That read returns it and resets it to zero.
- The lab log can read `gap_max` without resetting it.

## Touch

- While the mouse button is held on a pin, the pin is pushed: its real height drops toward 0 at the normal speed limit, whatever the ordered height.
- On release, the pin returns to its ordered height at the normal speed limit.
- There is no "touched" flag. Touch lives in the deviation trace, as a spike the body's own motion does not explain.
- A pin at height 0 cannot go lower, so pushing it leaves no deviation.

## Person

- The mouse position is the person's position, in pin units. It can leave the 0 to 8 range when the person is around the display.
- With the mouse outside the window, the person is absent and the position is null.
- The keyboard is the person's voice. The harness handles it.

## Color

- One global RGB color, standing for mood.
- Color changes are immediate in the beta.

## Observable state

- Simulation time in seconds.
- `target` and quantized `actual` for the 64 pins.
- `gap_max` for the 64 pins.
- Global color.
- The person's position, or null.

Numbers only. An image of the simulator as a sense comes later.

## Rendering

- Top view of the grid on a dark background, like the room.
- Each pin is a square whose brightness grows with real height, tinted by the global color.
- The mouse cursor marks the person.
- The window must be recordable for documentation.

## Acceptance criteria

1. An order from 0 to 1 completes in 0.5 s plus the response delay, within one tick.
2. A full-range oscillation faster than 1 cycle per second never reaches the extremes.
3. A pushed pin shows `actual` different from `target` during the click and recovers on release.
4. Reported heights take only 64 distinct values.
5. With the mouse outside the window, the person's position is null.
6. The same sequence of orders and inputs produces exactly the same result.
7. A brief touch between two agent reads shows in `gap_max` on the next read and is zero on the one after.

## Out of the beta

- Noise of ±1 level and one pin slower than the rest.
- A shared power budget across pins.
- Per-pin color and color transitions.
- The simulator image as a sense.
- A 3D view.

## Closed decisions

- **How much the agent is told:** the minimum needed to move. Details in `body-contract.md`.
- **Touch between two turns:** recorded in the deviation trace.
