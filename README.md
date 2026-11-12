# A body to wake up in

*Working title.*

I'm building a body out of shape displays, grids of pins that rise and fall, so an AI can discover it the way a newborn discovers its own hands: by moving, by sensing, by being touched. Nobody tells it what the body is or what it can do.

It feels like waking someone up. And nothing about it is human-shaped. There is no face, no limbs and no voice, only a surface that can lift, sink, change color and notice when a hand presses on it.

## Why

Most attempts to give AI a body start from ours. I want to start from the other end: a body with no human reference, and a mind that is not told who to be. It wakes up lying flat. It has no name and no task. If something like breathing ever shows up, I want it to be because the mind found it, not because I wrote it in.

I make no claim about what the AI experiences. The claim is smaller, and it can be tested: what a mind does with a body nobody explained is worth watching closely, and the body should be built carefully enough for the watching to be honest.

## Where this is going

1. **A virtual lab (now).** A simulated 8×8 body, a person played by mouse and keyboard, and a way to measure what emerges.
2. **One physical module.** 64 real pins driven by an Arduino and electronics I build myself.
3. **A room.** Surfaces of pins around a person. You walk into the dark and something notices you.

A first public milestone is Hackster's Emotion in Motion contest, built on the Arduino UNO R4 WiFi, with final entries due June 27, 2027. It is a deadline along the way, not the destination.

## Build this with me

I don't want to build this alone. If you have made shape displays or tangible interfaces, if you know mechanics and fabrication, if you design interactions or make art about things that seem alive, or if you study embodiment and language models, I would love to hear from you. The same goes if you just want to run the lab and compare what your entity did with what mine did.

Tell me what you would try, or what you think is wrong with it.

Contact: `David Huamani - dandress.hc@gmail.com`

## What is in this package

Specifications for the virtual lab. There is no code yet; these are the documents the code will be written from.

| File | Part | What it defines |
|---|---|---|
| `shape-display.md` | Body | The 8×8 grid, how pins move, touch, the person, color and the deviation trace |
| `body-contract.md` | Contract | The agent's four tools, what it is told and what it must discover |
| `nervous-system.md` | Nervous system | The player that turns tracks into motion; later, the firmware |
| `harness.md` | Harness | What wakes the agent, what it receives, limits, memory and logging |
| `mind.md` | Mind | The discovery prompt, memory across sessions and the success criterion |

## How it works, briefly

```
mind                prompt and a note carried across sessions
  │
harness             wakes it, hands it tools, logs everything
  │   play · stop · sense · set_color
body contract
  │
nervous system      tracks → ordered heights, 50 times per second
  │
shape display       moves the pins and keeps the deviation trace
  ▲
person              mouse (position and touch) and keyboard (voice)
```

- The body always runs. The mind exists only when the harness wakes it.
- The agent sends sparse looping trajectories and the nervous system turns them into motion.
- It is told the minimum needed to move. Speed, resolution and touch are left for it to find.
- Touch has no label. It shows up as a pin drifting from where the agent put it.
- It starts flat, and a flat body cannot feel. It has to rise before it can be touched.

The first question the lab has to answer: with this body and this prompt, does something like breathing emerge on its own? `mind.md` defines how that is measured across 10 sessions.

## Still open

These were set as defaults and have not been confirmed. Each document lists its own at the end:

- The bare wake message and the harness values (12 s pulse, 8 tool calls per turn, 40 turns or 15 minutes).
- The prompt text, which leaves out the order to "discover yourself".
- English as the language the agent reads.
- Memory across sessions as a single note that gets replaced.
- The thresholds of the success criterion and the person's script.

## Planned setup

- Python 3.11 or later, in a virtual environment.
- Dependencies: `anthropic`, `numpy`, `pygame`, `python-dotenv`.
- The API key in a local `.env` file, outside the repository.

## Next steps

1. Write the scaffold: simulator, nervous system, contract and a minimal harness loop.
2. Check each document's acceptance criteria.
3. Run the 10 first-day sessions and compute the criterion from the logs.

## Inspiration

Cyrus Clarke's experiment at the MIT Media Lab, giving an AI agent a 900-pin shape display as a body, and the Tangible Media Group's shape displays that came before it.
