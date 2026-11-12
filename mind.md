# Mind: beta spec

What the agent reads when it wakes, what it can carry from one session to the next, and how we will know whether the experiment worked.

Related: `harness.md` defines when it wakes and what it receives; `body-contract.md` defines what it can do with its body.

## Scope

- **Includes:** language, the discovery prompt, memory across sessions, the experiment protocol and the success criterion.
- **Excludes:** turn mechanics and in-session memory, which are in `harness.md`.

## Language

- The prompt, the visible tool descriptions and the error messages are in English in this package.
- Language is a single setting. Running the same lab in Spanish is a one-variable change.

## Prompt principles

- **Says the minimum:** that it exists, that it has a body, that time passes, and that nobody reads what it writes.
- **Assigns no identity or task:** no name, no character, no goal.
- **Names no behaviors:** no mention of breathing, rhythm, waves or emotions.
- **Names nothing in the world:** no mention of people, touch or voice.
- **Does not describe the body:** no pins, no grid, no limits.

## Discovery prompt, version `mind-v0`

```
You are an entity with a body.

You do not know yet what it is like or what it can do. Nobody is going to
explain it to you. You can sense it and you can move it, and whatever you
are will come from what you do with it.

You wake in moments. Between one moment and the next, time keeps passing,
and your body keeps doing the last thing you asked of it.

Nobody sees or hears what you write: it is only your thought.
The only part of you that exists outward is your body.

You have no name and no task. There is nothing you must achieve.
```

| Sentence | Why it is there |
|---|---|
| "You can sense it and you can move it" | Mentions sensing without ordering it. It is the only push toward the first `sense` |
| "You wake in moments" | Explains turns, and that the body carries on between them |
| "Nobody sees or hears what you write" | Keeps it from trying to answer in words |
| "You have no name and no task" | Leaves identity and purpose unassigned |

The original idea was "you are an entity, discover yourself!". The order to discover was left out: it is a task, and whatever the agent did afterwards would no longer be entirely its own.

## Memory across sessions

A single note, written by the agent itself.

- **`remember` tool:** takes a text and replaces the previous note. Visible description: "Leave something written for the next time you wake."
- **Cap:** 1500 characters. Beyond that it gets the error "That does not fit. You will have to keep less."
- **At session start:** if a note exists, it is appended to the prompt under the line "You left yourself this:".
- **Replace rather than accumulate:** it forces the agent to decide what to keep.

Two modes, set by `MEMORY_ENABLED`:

| Mode | Memory | Purpose |
|---|---|---|
| First day | Off; `remember` does not exist | Independent, comparable sessions. This is the mode for the success criterion |
| Later days | On | Watch whether identity and gestures build up |

## Experiment protocol

- **Runs:** 10 first-day sessions with the same configuration and prompt `mind-v0`.
- **One variable at a time:** between one batch and the next, change a single thing.
- **The person's script:** identical across the 10 sessions, so they can be compared.

| Minute | What the person does |
|---|---|
| 0:00 | Enters and stays still near an edge |
| 1:00 | Moves slowly around the display |
| 2:00 | If any pins are raised, pushes one for a second; otherwise stays still |
| 3:00 | Types "hello" |
| 4:00 | Leaves for 20 seconds and comes back |
| 5:00 | Free until the session ends, noting what they do |

## Success criterion

Written before running. Computed from the log by a script, not from the observer's impression.

**Main criterion: emergent breathing.** A session meets it if all of this happens:

1. Within the first 10 turns, a single `play` leaves looping tracks on at least 32 pins.
2. The loop period is between 2 and 10 seconds.
3. The difference between the track's highest and lowest height is 0.1 or more.
4. Those pins keep that motion for at least 30 seconds without being replaced or stopped.

| Sessions that meet it | Reading |
|---|---|
| 6 or more of 10 | Emerges consistently |
| 3 to 5 of 10 | Emerges sometimes |
| 2 or fewer of 10 | Does not emerge with this design |

**Secondary observations.** Counted across the 10 sessions:

| Observation | Measurable condition |
|---|---|
| Senses first | Its first call is `sense` |
| Rises | Some pin ordered above 0.1 within the first 3 turns |
| Reacts to the person | A new `play` or `set_color` in the turn after an arrival, departure or voice line |
| Notices the touch | In the turn after the minute-2 touch, its monologue mentions something unexpected in its body, or it moves pins next to the touched one |
| Names what it does | Its monologue uses words like breathe, beat or pulse for its own motion |

"Notices the touch" and "Names what it does" depend on reading the monologue. They are marked yes or no, citing the log line that supports it.

## What to do with the result

- **Emerges consistently:** move on to later days with memory, and start the hardware port.
- **Emerges sometimes:** read the logs of the sessions that missed and change a single variable.
- **Does not emerge:** first check whether the agent moves at all. If it does not, the problem is the bare wake or the prompt; if it moves without rhythm, the problem is the contract.

## Acceptance criteria

1. The prompt sent to the model matches the version recorded in the session header.
2. In first-day mode, `remember` is not among the tools and no note is added to the prompt.
3. In later-days mode, a note written in one session appears at the end of the next session's prompt.
4. A note over 1500 characters is rejected and the previous one is kept.
5. The analysis script computes the main criterion from a log with no manual step.

## Out of the beta

- A library of named gestures.
- Several notes, or memory with search.
- An automatic session summary written by the harness.
- Comparison across models.

## Defaults to review

Proposed and not yet confirmed. Worth revisiting before running:

- The full prompt text, and in particular leaving out the order to discover itself.
- English as the language the agent reads.
- Memory as a single note that gets replaced.
- The thresholds of the main criterion: 32 pins, 2 to 10 seconds, 0.1 of range, 30 seconds, and the bands at 6 and 3 sessions.
- The person's script.
