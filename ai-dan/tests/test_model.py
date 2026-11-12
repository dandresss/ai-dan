"""The model client (without the network) and the wiring-test pattern."""
from __future__ import annotations

import anthropic
import httpx2
import pytest
from anthropic.types import Message
from harness_fakes import FakeWorld, assert_valid

from lab import model as model_module
from lab.config import Config
from lab.harness import Harness
from lab.model import AnthropicModel, ScriptedModel, make_model, thinking_param, wrap_error

REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def status_error(cls, code):
    return cls("boom", response=httpx2.Response(code, request=REQUEST), body=None)


@pytest.mark.parametrize("exc, retryable", [
    (status_error(anthropic.RateLimitError, 429), True),
    (status_error(anthropic.InternalServerError, 500), True),
    (status_error(anthropic.InternalServerError, 529), True),
    (anthropic.APIConnectionError(request=REQUEST), True),
    (status_error(anthropic.APIStatusError, 408), True),
    (status_error(anthropic.ConflictError, 409), True),
    (anthropic.APITimeoutError(request=REQUEST), False),   # would only hang the turn again
    (status_error(anthropic.BadRequestError, 400), False),
    (status_error(anthropic.AuthenticationError, 401), False),
    (status_error(anthropic.NotFoundError, 404), False),
])
def test_errors_are_sorted_for_retry(exc, retryable):
    assert wrap_error(exc).retryable is retryable


def test_thinking_setting():
    assert thinking_param(Config()) == {"type": "adaptive", "display": "summarized"}
    assert thinking_param(Config(THINKING="between_tools")) == {"type": "between_tools"}


class FakeMessages:
    def __init__(self, result):
        self.result = result
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def anthropic_model(monkeypatch, result):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    m = AnthropicModel(Config())
    m.client.messages = FakeMessages(result)
    return m


def test_request_shape_and_response(monkeypatch):
    message = Message.model_validate({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
        "content": [{"type": "thinking", "thinking": "hm", "signature": "sig"},
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "id": "toolu_1", "name": "sense", "input": {}}],
        "stop_reason": "tool_use", "stop_sequence": None,
        "usage": {"input_tokens": 120, "output_tokens": 30},
    })
    m = anthropic_model(monkeypatch, message)
    assert m.client.max_retries == 0
    result = m.respond("sys", [{"name": "sense"}], [{"role": "user", "content": "x"}])
    assert m.client.messages.kwargs == {
        "model": "claude-sonnet-5-5", "max_tokens": 4096, "system": "sys",
        "tools": [{"name": "sense"}], "messages": [{"role": "user", "content": "x"}],
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "low"}, "timeout": 120.0,
    }
    assert result.content == [{"type": "thinking", "thinking": "hm", "signature": "sig"},
                              {"type": "text", "text": "hello"},
                              {"type": "tool_use", "id": "toolu_1", "name": "sense", "input": {}}]
    assert (result.stop_reason, result.model, result.input_tokens, result.output_tokens) == \
        ("tool_use", "claude-sonnet-5-5", 120, 30)


def test_sdk_errors_become_model_errors(monkeypatch):
    m = anthropic_model(monkeypatch, status_error(anthropic.RateLimitError, 429))
    with pytest.raises(model_module.ModelError) as info:
        m.respond("sys", [], [{"role": "user", "content": "x"}])
    assert info.value.retryable


def test_make_model_without_credentials(monkeypatch, tmp_path):
    monkeypatch.setattr(model_module, "_load_dotenv", lambda: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(model_module.Path, "home", lambda: tmp_path)
    assert make_model(Config()) is None
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    made = make_model(Config())
    assert isinstance(made, AnthropicModel) and made.name == "claude-sonnet-5-5"


# --- the wiring test -----------------------------------------------------------

def test_scripted_model_is_a_mechanical_test_pattern():
    world = FakeWorld()
    scripted = ScriptedModel(Config())
    sent = []

    class Recording:
        name = scripted.name

        def respond(self, system, tools, messages):
            assert_valid(messages)
            sent.append(messages)
            return scripted.respond(system, tools, messages)

    h = Harness(world, Recording(), Config())
    h.start(run_thread=False)
    world.enter()
    for n in range(7):
        world.t = 12.0 * n
        assert h.step()

    assert world.logged("header")[0]["mind"] == "scripted"
    names = [name for name, _ in world.body.calls]
    assert {"sense", "play", "stop", "set_color"} <= set(names)
    assert world.logged("wake")[6]["turn"] == 7 and names[-1] == "sense"   # the cycle repeats
    thoughts = [e["text"] for e in world.logged("thought")]
    assert thoughts and all(t.startswith("wiring test: step ") for t in thoughts)
    ends = world.logged("turn_end")
    assert all(not e["capped"] and not e["skipped"] for e in ends)

    plays = [args for name, args in world.body.calls if name == "play"]
    invalid = plays[-1]["tracks"][0]["pins"][0]
    assert invalid[0] >= 8 and invalid[1] >= 8          # outside the grid on purpose
    # Nothing in the pattern could pass for breathing: only one pin ever loops.
    looping = [t for args in plays for t in args["tracks"] if t.get("loop")]
    assert sum(len(t["pins"]) for t in looping) == 1
