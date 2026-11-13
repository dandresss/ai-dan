"""A body to wake up in: open the room.

    uv run python main.py                  a live session (needs ANTHROPIC_API_KEY in .env)
    uv run python main.py --dry-run        the whole loop with a scripted mind: a wiring test, not an AI
    uv run python main.py --replay FILE    watch a recorded session again, without the API
    uv run python main.py --verify FILE    check that a log replays to the same body states
"""
import sys

from lab.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
