# Nervous system: beta spec

The layer that turns the agent's sparse orders into an ordered height for every pin, every tick. It lives with the body: a Python module inside the simulator today, the Arduino UNO R4 firmware later. It keeps running when the agent is silent.

Related: `body-contract.md` defines the calls it receives; `shape-display.md` defines the body it moves.

## Scope

- **Receives:** `play` and `stop` calls already validated by the contract.
- **Delivers:** 64 ordered heights to the display, once per tick.
- **Excludes:** validation and errors (contract), physical motion and deviation trace (display), pulse and turns (harness).

## Initial state

- All 64 pins start with ordered height 0 and no track: flat and still.
- A pin at height 0 registers no touch, so the body is numb until the agent rises on its own.
- If the agent never calls `play`, the body stays flat forever. No motion comes from anywhere else.

## Per-pin state

| Field | Meaning |
|---|---|
| `keyframes` | Its own copy of the track's keyframes, up to 16 |
| `loop` | Whether the track repeats |
| `ease` | `"smooth"` or `"linear"` |
| `t_start` | When the track begins: arrival plus `delay_s` |
| `hold` | Height it keeps with no track, while waiting, or after finishing |

Each pin keeps its own copy. There is no shared pool of tracks to manage.

## Tick

Runs 50 times per second on the simulation clock:

1. Apply the calls that arrived since the last tick, in arrival order.
2. Compute each pin's ordered height.
3. Hand the 64 heights to the display.
4. The display does its part: response delay, speed limit, deviation trace.

## Ordered height

For one pin at time `t`:

```
if it has no track:            ordered = hold
tau = t - t_start
if tau < 0:                    ordered = hold
D = time of the last keyframe
if loop:                       tau = tau mod D
if not loop and tau >= D:      ordered = height of the last keyframe
                               hold = that height; release the track
otherwise:
    find the segment [i, i+1] containing tau
    u = (tau - t_i) / (t_i+1 - t_i)
    if ease is smooth:         u = (1 - cos(pi * u)) / 2
    ordered = h_i + (h_i+1 - h_i) * u
```

## Easing

- **`linear`:** constant speed between keyframes.
- **`smooth`:** half a cosine wave per segment; speed is zero at each keyframe.

With `smooth`, three keyframes going up and back in a loop give an exact sinusoid. `[[0, 0.2], [2, 0.8], [4, 0.2]]` yields 0.2, 0.5, 0.8 and 0.5 at seconds 0, 1, 2 and 3.

## When a track arrives

For each pin in the track:

1. `hold` takes the pin's ordered height at that instant.
2. The pin copies the keyframes, `loop` and `ease`.
3. `t_start` is now plus `delay_s`.

The pin's previous track is dropped. Pins not mentioned keep their motion and their phase.

## When a `stop` arrives

For each pin named: `hold` takes its ordered height at that instant and its track is released.

## Time and network

- A call takes effect on the next tick, within 20 ms.
- Network delay between laptop and board is not simulated: each agent turn takes seconds.
- The delay that does exist is in the display: the actuator's response.

## What it does not do in v0

- No reflexes or triggers: it never starts a motion by itself.
- No gradual blending between tracks; the pin's speed limit smooths the transition.
- It stops nothing when the agent goes quiet: a looping track runs indefinitely.

## Notes for the UNO R4 port

- **Time:** 16-bit integer in 10 ms units, hence the contract's 600 s cap per track.
- **Height:** 8-bit integer, 0 to 63.
- **Memory:** about 56 bytes per pin, roughly 3.6 KB against the board's 32 KB.
- **Load:** 64 pins times 50 ticks is 3200 evaluations per second.

## Acceptance criteria

1. With no calls, all 64 ordered heights stay at 0.
2. The three-keyframe `smooth` loop gives 0.2, 0.5, 0.8 and 0.5 at seconds 0, 1, 2 and 3.
3. A track without `loop` ends and the pin holds the last keyframe's height.
4. With `delay_s`, the pin holds its height until the wait is over.
5. A `play` on a subset leaves the phase of the other pins untouched.
6. A `stop` freezes each pin at its ordered height of that instant.
7. The same calls at the same instants produce the same ordered heights.

## Closed decisions

- **End of session:** the body stays as it is. Nothing stops by itself. See `harness.md`.
