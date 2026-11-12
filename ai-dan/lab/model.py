"""The model behind the mind.

AnthropicModel  the real one: one request per `respond`, no retries (the
                harness owns retries), plain-dict content blocks.
ScriptedModel   a wiring test for --dry-run: a fixed, mechanical pattern
                that exercises every tool. It is not a mind and must not look
                like one.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import ROOT, Config


@dataclass
class ModelResponse:
    content: list        # content blocks as dicts, to be echoed back unchanged within the turn
    stop_reason: str
    model: str           # the model that actually answered
    input_tokens: int
    output_tokens: int


class ModelError(Exception):
    """A failed model request. `retryable` says whether trying again may help."""

    def __init__(self, message: str, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


class Model(Protocol):
    name: str

    def respond(self, system: str, tools: list[dict], messages: list[dict]) -> ModelResponse: ...


# --- the real model ------------------------------------------------------

def thinking_param(config: Config) -> dict:
    if config.THINKING == "between_tools":
        return {"type": "between_tools"}
    return {"type": "adaptive", "display": "summarized"}


def wrap_error(exc: Exception) -> ModelError:
    """Sort an SDK exception into retryable (rate limit, connection, 408, 409,
    5xx) or not (any other 4xx, anything unexpected). A timeout is not
    retried: a request that ran out of time once is likely to do so again,
    and the turn would hang for minutes."""
    import anthropic

    name = type(exc).__name__
    if isinstance(exc, anthropic.APITimeoutError):
        return ModelError(f"{name}: {exc}", retryable=False)
    if isinstance(exc, (anthropic.RateLimitError, anthropic.APIConnectionError)):
        return ModelError(f"{name}: {exc}", retryable=True)
    if isinstance(exc, anthropic.APIStatusError):
        code = exc.status_code
        return ModelError(f"{name} {code}: {exc}", retryable=code >= 500 or code in (408, 409))
    return ModelError(f"{name}: {exc}", retryable=False)


class AnthropicModel:
    def __init__(self, config: Config):
        import anthropic

        self.config = config
        self.name = config.MODEL
        self.client = anthropic.Anthropic(max_retries=0)

    def respond(self, system: str, tools: list[dict], messages: list[dict]) -> ModelResponse:
        import anthropic

        config = self.config
        try:
            message = self.client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=system,
                tools=tools,
                messages=messages,
                thinking=thinking_param(config),
                output_config={"effort": config.EFFORT},
                timeout=120.0,
            )
        except anthropic.AnthropicError as exc:
            raise wrap_error(exc) from exc
        return ModelResponse(
            content=[block.to_dict() for block in message.content],
            stop_reason=message.stop_reason,
            model=message.model,
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
        )


def _load_dotenv() -> None:
    """Load the first .env found from the project root upward. The key is meant
    to live outside the repository (harness.md)."""
    from dotenv import load_dotenv

    for directory in (ROOT, *ROOT.parents):
        candidate = directory / ".env"
        if candidate.is_file():
            load_dotenv(candidate)
            return


def has_credentials() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    profiles = Path.home() / ".config" / "anthropic"
    return profiles.is_dir() and any(profiles.iterdir())


def make_model(config: Config) -> Model | None:
    _load_dotenv()
    if not has_credentials():
        return None
    return AnthropicModel(config)


# --- the wiring test -----------------------------------------------------

def _tool(name: str, args: dict) -> tuple[str, dict]:
    return (name, args)


def _wiring_script(config: Config) -> list[list[list[tuple[str, dict]]]]:
    """Turns, each a list of responses, each a list of tool calls. A response
    with no calls ends the turn. The cycle repeats for as long as it is woken."""
    rows, cols = config.GRID_ROWS, config.GRID_COLS
    black = [[r, c] for r in range(rows) for c in range(cols) if (r + c) % 2 == 0]
    white = [[r, c] for r in range(rows) for c in range(cols) if (r + c) % 2 == 1]
    checkerboard = {"tracks": [
        {"pins": black, "keyframes": [[0, 0], [1, 1]], "ease": "linear"},
        {"pins": white, "keyframes": [[0, 0], [1, 0]], "ease": "linear"},
    ]}
    # One corner pin blinks in a square pattern: exercises `loop` on one pin only.
    blink = {"tracks": [{"pins": [[0, 0]], "loop": True, "ease": "linear",
                         "keyframes": [[0, 0], [0.05, 1], [0.5, 1], [0.55, 0], [1, 0]]}]}
    # Rows rise and fall one after another, once.
    sweep = {"tracks": [
        {"pins": [[r, c] for c in range(cols)], "delay_s": r * 0.25, "ease": "linear",
         "keyframes": [[0, 0], [0.5, 1], [1, 0]]}
        for r in range(rows)
    ]}
    # A pin outside the grid: the body must reject the whole call.
    invalid = {"tracks": [{"pins": [[rows + 1, cols + 1]], "keyframes": [[0, 0], [1, 1]]}]}
    return [
        [[_tool("sense", {})], []],
        [[_tool("play", checkerboard), _tool("sense", {})], []],
        [[_tool("set_color", {"rgb": [0, 128, 255]}), _tool("play", blink)], []],
        [[_tool("play", sweep)], [_tool("sense", {})], []],
        [[_tool("stop", {})], []],
        [[_tool("play", invalid)], []],
    ]


class ScriptedModel:
    """Not a mind: a fixed test pattern that checks the wiring without a key."""

    name = "scripted"

    def __init__(self, config: Config | None = None):
        self.script = _wiring_script(config or Config())
        self.turn = -1
        self.step = 0
        self.responses = 0
        self.ids = 0

    def respond(self, system: str, tools: list[dict], messages: list[dict]) -> ModelResponse:
        # A turn begins with a user message that carries the wake text.
        last = messages[-1]["content"] if messages else []
        if isinstance(last, str) or any(b.get("type") == "text" for b in last):
            self.turn += 1
            self.step = 0
        turn = self.script[self.turn % len(self.script)]
        calls = turn[min(self.step, len(turn) - 1)]
        self.step += 1
        self.responses += 1

        label = f"wiring test: step {self.responses}"
        content: list[dict] = [{"type": "text", "text": label if calls else label + ", done"}]
        for name, args in calls:
            self.ids += 1
            content.append({"type": "tool_use", "id": f"toolu_wiring_{self.ids:04d}",
                            "name": name, "input": args})
        return ModelResponse(content=content,
                             stop_reason="tool_use" if calls else "end_turn",
                             model=self.name, input_tokens=0, output_tokens=0)
