"""The shape display: 64 pins that follow orders late, slowly and imperfectly."""
from __future__ import annotations

from collections import deque

from .body import Snapshot
from .config import Config


class Display:
    def __init__(self, config: Config):
        self.config = config
        n = config.n_pins
        self.target = [0.0] * n      # latest ordered heights, quantized on arrival
        self.actual = [0.0] * n      # real heights, continuous
        self.gap_max = [0.0] * n     # deviation trace since the last sense
        # Past targets; the oldest is the one the actuator is following now.
        self.delay_line = deque([self.target] * (config.response_ticks + 1),
                                maxlen=config.response_ticks + 1)
        self.color = tuple(config.DEFAULT_COLOR)
        self.person = None           # (row, column) in pin units, or None
        self.pressed = None          # (row, column) of the pushed pin, or None

    def step(self, ordered: list) -> None:
        """One tick: take the ordered heights, move every pin, update the trace."""
        top = self.config.LEVELS - 1
        self.target = [round(min(max(h, 0.0), 1.0) * top) / top for h in ordered]
        self.delay_line.append(self.target)
        following = self.delay_line[0]
        limit = self.config.max_step
        pushed = self._index(self.pressed)
        for i in range(self.config.n_pins):
            goal = 0.0 if i == pushed else following[i]
            a = self.actual[i]
            if abs(goal - a) <= limit:
                a = goal
            else:
                a += limit if goal > a else -limit
            self.actual[i] = a
            self.gap_max[i] = max(self.gap_max[i], abs(self.target[i] - a))

    def sense(self) -> dict:
        """Reported state, without the time. Reading resets the trace."""
        top = self.config.LEVELS - 1
        actual = [round(round(a * top) / top, 2) for a in self.actual]
        gap = [round(g, 2) for g in self.gap_max]
        self.gap_max = [0.0] * self.config.n_pins
        person = None
        if self.person is not None:
            person = [round(self.person[0], 1), round(self.person[1], 1)]
        return {"actual": self._matrix(actual), "gap": self._matrix(gap),
                "person": person, "color": list(self.color)}

    def snapshot(self, tick: int, t: float) -> Snapshot:
        """For the lab: never resets the trace."""
        return Snapshot(tick=tick, t=t, rows=self.config.GRID_ROWS, cols=self.config.GRID_COLS,
                        target=self._matrix(self.target), actual=self._matrix(self.actual),
                        gap_max=self._matrix(self.gap_max), color=self.color,
                        person=self.person, pressed=self.pressed)

    def state(self) -> list:
        return [self.target, self.actual, self.gap_max, list(self.delay_line),
                self.color, self.pressed, self.person]

    def _index(self, pin):
        return None if pin is None else pin[0] * self.config.GRID_COLS + pin[1]

    def _matrix(self, flat: list) -> list:
        cols = self.config.GRID_COLS
        return [list(flat[r * cols:(r + 1) * cols]) for r in range(self.config.GRID_ROWS)]
