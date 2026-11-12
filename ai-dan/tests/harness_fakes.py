"""Fakes for the harness tests: a world with a clock the test sets, a body
that answers instantly, and a model that plays a script and checks every
message list it is sent."""
from __future__ import annotations

import copy
import json
import queue

from lab.body import BODY_TOOLS, WorldClosed
from lab.log import SessionLog
from lab.model import ModelResponse


class FakeBody:
    def __init__(self, world: "FakeWorld"):
        self.world = world
        self.calls: list[tuple[str, dict | None]] = []

    def call(self, name, args=None):
        world = self.world
        if world.closed or world.close_on_call:
            world.closed = True
            raise WorldClosed()
        self.calls.append((name, args))
        if name == "sense":
            result = {"t": world.t, "actual": [[0.0] * 8 for _ in range(8)],
                      "gap": [[0.0] * 8 for _ in range(8)], "person": None,
                      "color": [255, 255, 255]}
        elif name in BODY_TOOLS:
            result = {"ok": True, "t": world.t}
        else:
            result = {"ok": False, "t": world.t, "error": "unknown"}
        world.log.write({"type": "call", "turn": world.turn, "tick": round(world.t * 50),
                         "t": world.t, "name": name, "args": args, "result": result})
        world.t = round(world.t + world.call_s, 2)
        return result


class FakeWorld:
    def __init__(self):
        self.events: queue.Queue = queue.Queue()
        self.t = 0.0
        self.turn = 0
        self.log = SessionLog(None)
        self.closed = False
        self.close_on_call = False
        self.call_s = 0.0    # simulated seconds each body call takes
        self.body = FakeBody(self)

    def remote_body(self):
        return self.body

    def enter(self):
        self.events.put(("enter", self.t))

    def leave(self):
        self.events.put(("leave", self.t))

    def say(self, line: str):
        self.events.put(("voice", self.t, line))

    def logged(self, kind: str | None = None) -> list[dict]:
        events = self.log.feed.since(0)
        return [e for e in events if kind is None or e["type"] == kind]


def response(*blocks, stop: str | None = None, model: str = "fake") -> ModelResponse:
    blocks = list(blocks)
    if stop is None:
        stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
    return ModelResponse(content=blocks, stop_reason=stop, model=model,
                         input_tokens=10, output_tokens=5)


def say(words: str) -> dict:
    return {"type": "text", "text": words}


def think(words: str, signature: str = "sig") -> dict:
    return {"type": "thinking", "thinking": words, "signature": signature}


_ids = iter(range(1, 10**9))


def use(name: str, args: dict | None = None) -> dict:
    return {"type": "tool_use", "id": f"toolu_{next(_ids):05d}", "name": name,
            "input": args if args is not None else {}}


class FakeModel:
    """Plays `script` in order: each entry is a ModelResponse, an exception to
    raise, or a callable(messages) returning either. When the script runs out
    it answers with a quiet end of turn."""

    name = "fake"

    def __init__(self, script=None, on_call=None):
        self.script = list(script or [])
        self.on_call = on_call
        self.sent: list[list[dict]] = []
        self.systems: list[str] = []
        self.tools: list[list[dict]] = []

    def respond(self, system, tools, messages):
        assert_valid(messages)
        self.sent.append(copy.deepcopy(messages))
        self.systems.append(system)
        self.tools.append(tools)
        if self.on_call:
            self.on_call(len(self.sent))
        item = self.script.pop(0) if self.script else response(say("..."))
        if callable(item) and not isinstance(item, ModelResponse):
            item = item(messages)
        if isinstance(item, BaseException):
            raise item
        return copy.deepcopy(item)


def assert_valid(messages: list[dict]) -> None:
    """The message list the API will accept: starts with the user; no empty
    message or text block; every tool_use answered in the next user message;
    every tool_result answers the assistant message just before it; thinking
    blocks only inside the current turn (after the last wake text)."""
    assert messages and messages[0]["role"] == "user"
    last_wake = max(i for i, m in enumerate(messages)
                    if m["role"] == "user" and any(b["type"] == "text" for b in m["content"]))
    for i, m in enumerate(messages):
        assert m["role"] in ("user", "assistant")
        assert i == 0 or m["role"] != messages[i - 1]["role"], f"message {i} repeats a role"
        assert m["content"], f"message {i} is empty"
        for b in m["content"]:
            if b["type"] == "text":
                assert b["text"].strip(), f"message {i} has an empty text block"
            if b["type"] in ("thinking", "redacted_thinking"):
                assert i > last_wake, f"message {i} replays a thinking block from a past turn"
        if m["role"] == "assistant":
            ids = [b["id"] for b in m["content"] if b["type"] == "tool_use"]
            if ids:
                assert i + 1 < len(messages), f"message {i}: tool_use with no answer"
                nxt = messages[i + 1]
                assert nxt["role"] == "user"
                answered = [b["tool_use_id"] for b in nxt["content"] if b["type"] == "tool_result"]
                assert sorted(answered) == sorted(ids), f"message {i}: unanswered tool_use"
                # results come before any text in that user message
                kinds = [b["type"] for b in nxt["content"]]
                assert kinds == sorted(kinds, key=lambda k: k != "tool_result")
        else:
            results = [b["tool_use_id"] for b in m["content"] if b["type"] == "tool_result"]
            if results:
                prev = messages[i - 1]
                assert prev["role"] == "assistant"
                assert set(results) <= {b["id"] for b in prev["content"] if b["type"] == "tool_use"}
            for b in m["content"]:
                if b["type"] == "tool_result":
                    json.loads(b["content"])
