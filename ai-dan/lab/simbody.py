"""SimBody: the simulated body. Contract on the outside, nervous system and
shape display on the inside. Single-threaded and deterministic."""
from __future__ import annotations

import hashlib
import json

from .body import Snapshot
from .config import Config
from .contract import Contract
from .display import Display
from .nervous import NervousSystem


def _rounded(x):
    """Floats to 9 decimals, so a hash does not depend on the last bits."""
    if isinstance(x, float):
        return round(x, 9)
    if isinstance(x, (list, tuple)):
        return [_rounded(v) for v in x]
    return x


class SimBody:
    def __init__(self, config: Config):
        self.config = config
        self.tick = 0                    # completed steps
        self.nervous = NervousSystem(config)
        self.display = Display(config)
        self.contract = Contract(config, self.nervous, self.display)

    @property
    def t(self) -> float:
        return self.config.time_of(self.tick)

    def set_person(self, pos) -> None:
        self.display.person = None if pos is None else (pos[0], pos[1])

    def set_pressed(self, pin) -> None:
        self.display.pressed = None if pin is None else (pin[0], pin[1])

    def call(self, name: str, args: dict | None = None) -> dict:
        return self.contract.call(name, args, self.tick)

    def step(self) -> None:
        """Ordered heights for the current time, handed to the display; then time moves on."""
        self.display.step(self.nervous.heights(self.tick / self.config.TICK_HZ))
        self.tick += 1

    def snapshot(self) -> Snapshot:
        return self.display.snapshot(self.tick, self.t)

    def state_hash(self) -> str:
        state = _rounded([self.tick, self.display.state(), self.nervous.state()])
        return hashlib.sha256(json.dumps(state).encode()).hexdigest()[:16]
