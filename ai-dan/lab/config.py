"""Every parameter from every spec, in one place.

The session log header records this whole table, so a session can always be
traced back to the exact values that produced it. Any field can be overridden
from the environment (or .env) as LAB_<NAME>, for example LAB_PULSE_S=8.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SESSIONS_DIR = ROOT / "sessions"
NOTE_PATH = ROOT / "memory" / "note.txt"


@dataclass
class Config:
    # --- shape-display.md -------------------------------------------------
    GRID_ROWS: int = 8
    GRID_COLS: int = 8
    LEVELS: int = 64             # distinguishable height levels
    FULL_TRAVEL_S: float = 0.5   # seconds to travel from 0 to 1
    TICK_HZ: int = 50            # simulation ticks per second
    RESPONSE_MS: int = 80        # actuator response delay
    DEFAULT_COLOR: tuple = (255, 255, 255)

    # --- body-contract.md (internal caps, never shown to the agent) -------
    MAX_TRACKS: int = 16
    MAX_KEYFRAMES: int = 16
    MAX_TRACK_S: float = 600.0

    # --- harness.md -------------------------------------------------------
    PULSE_S: float = 12.0        # seconds between wakes while someone is present
    ABSENCE_GRACE_S: float = 2.0
    MAX_TOOL_CALLS: int = 8      # per turn
    MAX_TURNS: int = 40          # per session
    MAX_SESSION_MIN: float = 15.0
    MEMORY_FULL_TURNS: int = 6   # recent turns kept in full
    MAX_TOKENS: int = 4096       # spec default was 1024; see README "Where the code differs"
    MODEL: str = "claude-sonnet-5-5"
    EFFORT: str = "low"          # low | medium | high | xhigh | max
    THINKING: str = "adaptive"   # adaptive | between_tools

    # --- mind.md ----------------------------------------------------------
    PROMPT_VERSION: str = "mind-v0"
    LANGUAGE: str = "en"
    MEMORY_ENABLED: bool = False  # False = first-day mode: no `remember`, no note
    NOTE_MAX_CHARS: int = 1500

    # --- lab bookkeeping (not in the specs) -------------------------------
    STATE_EVERY_TICKS: int = 250  # a body-state checksum goes to the log this often

    # --- derived ----------------------------------------------------------
    @property
    def n_pins(self) -> int:
        return self.GRID_ROWS * self.GRID_COLS

    @property
    def max_step(self) -> float:
        """Largest height change per tick: 0.04 with the defaults."""
        return 1.0 / (self.FULL_TRAVEL_S * self.TICK_HZ)

    @property
    def response_ticks(self) -> int:
        """Actuator response delay in whole ticks: 4 with the defaults."""
        return round(self.RESPONSE_MS * self.TICK_HZ / 1000)

    def time_of(self, tick: int) -> float:
        """Simulation seconds at a tick, as reported everywhere (two decimals)."""
        return round(tick / self.TICK_HZ, 2)

    def tick_of(self, t: float) -> int:
        return round(t * self.TICK_HZ)

    # --- (de)serialisation ------------------------------------------------
    def to_dict(self) -> dict:
        out = {}
        for f in fields(self):
            value = getattr(self, f.name)
            out[f.name] = list(value) if isinstance(value, tuple) else value
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        cfg = cls()
        for f in fields(cls):
            if f.name in data:
                value = data[f.name]
                if isinstance(getattr(cfg, f.name), tuple):
                    value = tuple(value)
                setattr(cfg, f.name, value)
        return cfg

    @classmethod
    def from_env(cls) -> "Config":
        cfg = cls()
        for f in fields(cls):
            raw = os.environ.get(f"LAB_{f.name}")
            if raw is None or raw == "":
                continue
            default = getattr(cfg, f.name)
            if isinstance(default, bool):
                value = raw.strip().lower() in ("1", "true", "yes", "on")
            elif isinstance(default, int):
                value = int(raw)
            elif isinstance(default, float):
                value = float(raw)
            elif isinstance(default, tuple):
                value = tuple(int(part) for part in raw.split(","))
            else:
                value = raw
            setattr(cfg, f.name, value)
        return cfg
