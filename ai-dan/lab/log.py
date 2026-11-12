"""Session log: one file per session, one JSON object per line.

Everything that happens goes through `SessionLog.write`, from any thread. Each
event also lands in an in-memory `Feed`, which is what the window reads to
show the observer panel, live or in replay.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path

from .config import SESSIONS_DIR, Config

LOG_VERSION = 1


class Feed:
    """Thread-safe, append-only list of events."""

    def __init__(self):
        self._events: list[dict] = []
        self._lock = threading.Lock()

    def append(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)

    def since(self, index: int) -> list[dict]:
        """Events from `index` on. Keep `index + len(result)` for the next call."""
        with self._lock:
            return self._events[index:]

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)


class SessionLog:
    def __init__(self, path: Path | str | None = None, feed: Feed | None = None):
        """With `path=None` nothing is written to disk; the feed still fills."""
        self.path = Path(path) if path else None
        self.feed = feed if feed is not None else Feed()
        self._lock = threading.Lock()
        self._file = None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._file = open(self.path, "w", encoding="utf-8", newline="\n")

    def write(self, event: dict) -> None:
        line = json.dumps(event, ensure_ascii=False, default=str)
        with self._lock:
            if self._file:
                self._file.write(line + "\n")
                self._file.flush()
            # The feed gets the JSON-normalised copy, so live and replay match.
            self.feed.append(json.loads(line))

    def write_header(self, config: Config, **extra) -> None:
        self.write({
            "type": "header",
            "version": LOG_VERSION,
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "config": config.to_dict(),
            **extra,
        })

    def close(self) -> None:
        with self._lock:
            if self._file:
                self._file.close()
                self._file = None


def read_log(path: Path | str) -> list[dict]:
    events = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def new_log_path(directory: Path | str = SESSIONS_DIR) -> Path:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    path = directory / f"{stamp}.jsonl"
    n = 2
    while path.exists():
        path = directory / f"{stamp}_{n}.jsonl"
        n += 1
    return path
