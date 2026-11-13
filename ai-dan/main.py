"""A body to wake up in: open the room.

    uv run main.py                  the lab in a web page at http://localhost:8080 (a mind wakes
                                    on the ANTHROPIC_API_KEY in .env)
    uv run main.py --desktop        the desktop room: a live session in a window
    uv run main.py --dry-run        the desktop room with a scripted mind: a wiring test, not an AI
    uv run main.py --replay FILE    watch a recorded session again, without the API
    uv run main.py --verify FILE    check that a log replays to the same body states
"""
import sys

from lab.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
