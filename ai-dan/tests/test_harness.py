"""The mind loop, driven step by step with a clock the test controls."""
from __future__ import annotations

import json
import threading
import time

from harness_fakes import FakeModel, FakeWorld, response, say, think, use

from lab.config import Config
from lab.harness import Harness
from lab.model import ModelError


def make(script=None, config=None, on_call=None, note_path=None):
    world = FakeWorld()
    model = FakeModel(script, on_call=on_call)
    harness = Harness(world, model, config or Config(), note_path=note_path)
    harness.waits = []
    harness.sleep = harness.waits.append
    harness.start(run_thread=False)
    return world, model, harness


def advance(world, harness, until, dt=0.5):
    """Step the harness while the clock runs to `until`. Returns turns run."""
    turns = 0
    while world.t < until:
        turns += harness.step()
        world.t = round(world.t + dt, 2)
    return turns


def wake_texts(model):
    """The wake text of each turn, in order, as sent to the model."""
    seen, out = set(), []
    for messages in model.sent:
        for i, m in enumerate(messages):
            for b in m["content"]:
                if m["role"] == "user" and b["type"] == "text" and i not in seen:
                    seen.add(i)
                    out.append(b["text"])
    return out


# --- session start ----------------------------------------------------------

def test_header_first_and_nothing_sent_before_arrival():   # harness.md criterion 1
    world, model, h = make()
    assert world.logged()[0]["type"] == "header"
    world.say("is anyone there")         # a line typed before the mouse ever entered
    advance(world, h, 60)
    assert model.sent == []
    assert h.started_at is None

    world.enter()
    h.step()
    assert len(model.sent) == 1
    wake = world.logged("wake")[0]
    assert wake["reasons"] == ["voice", "arrival"]
    assert wake["message"] == json.dumps({"t": 60.0, "heard": ["is anyone there"]})


def test_header_records_the_prompt_actually_sent():   # mind.md criterion 1
    world, model, h = make()
    world.enter()
    h.step()
    header = world.logged("header")[0]
    assert header["prompt"] == model.systems[0]
    assert header["prompt_version"] == "mind-v0"
    assert header["tools"] == [t["name"] for t in model.tools[0]]
    assert header["model"] == "fake" and header["mind"] == "live"
    assert header["memory_enabled"] is False
    assert header["config"]["PULSE_S"] == 12.0


def test_wake_message_is_bare():
    world, model, h = make()
    world.enter()
    h.step()
    first = model.sent[0][-1]["content"]
    assert first == [{"type": "text", "text": '{"t": 0.0}'}]
    world.t = 31.5
    world.say("hello")
    h.step()
    assert model.sent[1][-1]["content"][-1]["text"] == '{"t": 31.5, "heard": ["hello"]}'


# --- wakes ---------------------------------------------------------------------

def test_pulse_only_while_present_and_one_farewell():   # harness.md criterion 3
    world, model, h = make()
    world.enter()
    advance(world, h, 60)
    wakes = world.logged("wake")
    assert [w["reasons"] for w in wakes] == [["arrival"]] + [["pulse"]] * 4
    assert [w["t"] for w in wakes] == [0.0, 12.0, 24.0, 36.0, 48.0]

    world.leave()
    advance(world, h, 200)
    after = world.logged("wake")[len(wakes):]
    assert [w["reasons"] for w in after] == [["departure"]]
    assert after[0]["t"] == 62.0          # left at 60, gone after the 2 s grace

    world.enter()
    advance(world, h, 213)
    back = world.logged("wake")[len(wakes) + 1:]
    assert [w["reasons"] for w in back] == [["arrival"], ["pulse"]]


def test_leaving_and_returning_within_the_grace_is_not_an_event():
    world, model, h = make()
    world.enter()
    advance(world, h, 5)
    world.leave()
    advance(world, h, 6.5)
    world.enter()
    advance(world, h, 30)
    assert [w["reasons"] for w in world.logged("wake")] == [["arrival"], ["pulse"], ["pulse"]]


def test_pulse_counts_from_the_end_of_the_turn():
    def slow(n):
        world.t = round(world.t + 5, 2)   # each model call takes 5 s of lab time
    world = FakeWorld()
    model = FakeModel(on_call=slow)
    h = Harness(world, model, Config())
    h.start(run_thread=False)
    world.enter()
    advance(world, h, 40)
    assert [w["t"] for w in world.logged("wake")] == [0.0, 17.0, 34.0]


def test_voice_wakes_even_without_pulse_and_touch_does_not():
    world, model, h = make()
    world.enter()
    h.step()
    world.t = 3.0
    world.say("hi")
    h.step()
    assert [w["reasons"] for w in world.logged("wake")] == [["arrival"], ["voice"]]


def test_lines_typed_during_a_turn_reach_the_next_wake():   # harness.md criterion 5
    def during(n):
        if n == 1:
            world.say("hello")
            world.say("are you there")
            world.leave()
            world.enter()      # back within the grace: no event
    world = FakeWorld()
    model = FakeModel([response(use("sense")), response(say("still"))], on_call=during)
    h = Harness(world, model, Config())
    h.start(run_thread=False)
    world.enter()
    h.step()
    world.t = 1.0
    assert h.step()
    wake = world.logged("wake")[1]
    assert wake["reasons"] == ["voice"]
    assert json.loads(wake["message"]) == {"t": 1.0, "heard": ["hello", "are you there"]}
    assert not h.step()


# --- session end -------------------------------------------------------------

def test_session_ends_at_max_turns():   # harness.md criterion 7
    world, model, h = make()
    world.enter()
    advance(world, h, 2000, dt=1.0)
    assert h.turn == 40 and len(world.logged("wake")) == 40
    close = world.logged("close")
    assert len(close) == 1 and close[0]["reason"] == "max_turns" and close[0]["turns"] == 40
    assert close[0]["input_tokens"] == 400 and close[0]["output_tokens"] == 200
    assert world.logged()[-1]["type"] == "close"


def test_session_ends_at_max_minutes_after_first_arrival():   # harness.md criterion 7
    world, model, h = make()
    world.t = 100.0
    world.enter()
    h.step()
    world.leave()
    advance(world, h, 999.5, dt=0.5)
    assert world.logged("close") == []
    advance(world, h, 1000.5, dt=0.5)
    close = world.logged("close")
    assert close[0]["reason"] == "max_minutes" and close[0]["t"] == 1000.0
    calls = len(model.sent)
    world.enter()
    world.say("hello?")
    advance(world, h, 1100)
    assert len(model.sent) == calls        # never woken again
    assert world.body.calls == []          # and the body is left alone


def test_session_time_runs_out_mid_turn():
    def slow(n):
        world.t = round(world.t + 400, 2)
    world = FakeWorld()
    model = FakeModel([response(use("sense")) for _ in range(5)], on_call=slow)
    h = Harness(world, model, Config())
    h.start(run_thread=False)
    world.enter()
    h.step()
    assert len(model.sent) == 3            # answered at 400, 800, 1200
    assert len(world.body.calls) == 2      # the calls answered at 1200 are not run
    kinds = [e["type"] for e in world.logged()][-2:]
    assert kinds == ["turn_end", "close"]
    assert world.logged("close")[0]["reason"] == "max_minutes"


def test_stop_is_idempotent_and_writes_one_close():
    world, model, h = make()
    world.enter()
    h.step()
    h.stop()
    h.stop("max_turns")
    close = world.logged("close")
    assert len(close) == 1 and close[0]["reason"] == "window_closed" and close[0]["turns"] == 1
    world.say("hello")
    assert not h.step()


def test_thread_runs_turns_and_stops():
    world = FakeWorld()
    model = FakeModel()
    h = Harness(world, model, Config())
    h.start()
    world.enter()
    deadline = time.monotonic() + 5
    while not world.logged("turn_end") and time.monotonic() < deadline:
        time.sleep(0.01)
    h.stop()
    assert len(model.sent) == 1
    assert not h._thread.is_alive()
    assert [e["type"] for e in world.logged()][-1] == "close"


# --- the turn --------------------------------------------------------------------

def test_turn_runs_calls_in_order_and_logs_everything():
    script = [
        response(think("what is this"), say("let me feel"), use("sense")),
        response(think(""), use("play", {"tracks": []}), use("set_color", {"rgb": [1, 2, 3]})),
        response(say("enough")),
    ]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert [c[0] for c in world.body.calls] == ["sense", "play", "set_color"]
    assert len(model.sent) == 3
    thoughts = [(e["kind"], e["text"]) for e in world.logged("thought")]
    assert thoughts == [("thinking", "what is this"), ("text", "let me feel"), ("text", "enough")]
    assert [e["stop_reason"] for e in world.logged("usage")] == ["tool_use", "tool_use", "end_turn"]
    assert all(e["turn"] == 1 for e in world.logged("call"))
    end = world.logged("turn_end")[0]
    assert end == {"type": "turn_end", "t": 0.0, "turn": 1, "tool_calls": 3,
                   "capped": False, "skipped": False}
    order = [e["type"] for e in world.logged() if e["type"] != "header"]
    assert order == ["wake", "usage", "thought", "thought", "call", "usage", "call", "call",
                     "usage", "thought", "turn_end"]


def test_turn_stops_at_eight_calls():   # harness.md criterion 4
    script = [response(use("sense"), use("sense"), use("sense")) for _ in range(5)]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert len(model.sent) == 3                  # 3 + 3 + 3 calls asked, 8 run
    assert len(world.body.calls) == 8
    end = world.logged("turn_end")[0]
    assert end["tool_calls"] == 8 and end["capped"] is True
    past = [e for e in world.logged("call") if "tick" not in e]
    assert len(past) == 1
    assert past[0]["result"] == {"ok": False, "t": 0.0, "error": "That is too much for one moment."}

    # The results of the last response travel with the next wake, before its text.
    world.t = 12.0
    h.step()
    nxt = model.sent[3][-1]["content"]
    assert [b["type"] for b in nxt] == ["tool_result"] * 3 + ["text"]
    assert json.loads(nxt[2]["content"])["error"] == "That is too much for one moment."
    assert nxt[3]["text"] == '{"t": 12.0}'


def test_one_response_with_more_calls_than_the_cap():
    script = [response(*[use("stop") for _ in range(11)])]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert len(model.sent) == 1
    assert len(world.body.calls) == 8
    assert len([e for e in world.logged("call") if "tick" not in e]) == 3


def test_api_failures_are_retried_with_growing_waits():
    script = [ModelError("overloaded", retryable=True),
              ModelError("connection", retryable=True),
              response(say("there"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    errors = world.logged("api_error")
    assert [(e["attempt"], e["error"]) for e in errors] == [(1, "overloaded"), (2, "connection")]
    assert h.waits == [2.0, 4.0]
    assert world.logged("turn_end")[0]["skipped"] is False


def test_persistent_failure_skips_the_turn():
    world, model, h = make([ModelError("down", retryable=True)] * 10)
    world.enter()
    h.step()
    assert len(model.sent) == 4                 # the first try and three retries
    assert h.waits == [2.0, 4.0, 8.0]
    assert world.logged("turn_end")[0]["skipped"] is True
    assert world.body.calls == []


def test_client_errors_are_not_retried():
    world, model, h = make([ModelError("BadRequestError 400", retryable=False)])
    world.enter()
    h.step()
    assert len(model.sent) == 1 and h.waits == []
    assert world.logged("turn_end")[0]["skipped"] is True


def test_failure_halfway_through_a_turn_leaves_a_valid_conversation():
    script = [response(think("hm"), use("sense")),
              ModelError("bad", retryable=False),
              response(say("again"), use("sense")),
              response(say("ok"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    world.t = 12.0
    h.step()      # FakeModel checks validity on every call
    last = model.sent[-1]
    assert [m["role"] for m in last] == ["user", "assistant", "user", "assistant", "user"]
    assert last[1]["content"][0] == {"type": "text", "text": "hm"}   # settled thinking
    # The next wake joined the message that was still waiting for an answer.
    assert [b["type"] for b in last[2]["content"]] == ["tool_result", "text"]
    assert last[2]["content"][1]["text"] == '{"t": 12.0}'


def test_refusal_is_logged_and_the_turn_skipped():
    script = [response(use("sense")), response(say("no"), stop="refusal"), response(say("fine"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert world.logged("usage")[-1]["stop_reason"] == "refusal"
    assert world.logged("turn_end")[0]["skipped"] is True
    world.t = 12.0
    h.step()
    assert all(b.get("text") != "no" for m in model.sent[-1] for b in m["content"])


def test_a_response_cut_off_at_the_output_cap_never_reaches_the_body():
    # A call cut off mid-way can still parse as a smaller, valid movement.
    script = [response(say("half"), use("play", {"tracks": [{"pins": "all"}]}), stop="max_tokens"),
              response(say("done"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert world.body.calls == []
    assert len(model.sent) == 1                      # the turn ends there
    refused = world.logged("call")[0]
    assert "tick" not in refused and refused["result"]["ok"] is False
    assert world.logged("turn_end")[0]["capped"] is True
    world.t = 12.0
    h.step()                                         # its answer travels with the next wake
    kinds = [b["type"] for b in model.sent[1][-1]["content"]]
    assert kinds == ["tool_result", "text"]


def test_leaving_and_returning_during_a_turn_is_not_lost():   # harness.md criterion 3
    def away(n):
        if n == 1:                        # while the model is thinking in turn 1
            world.t = 5.0
            world.leave()
            world.t = 25.0                # gone for 20 s, far past the grace
            world.enter()
            world.t = 26.0

    world, model, h = make(on_call=away)
    world.enter()
    h.step()
    h.step()
    assert [w["reasons"] for w in world.logged("wake")] == [["arrival"], ["departure", "arrival"]]
    advance(world, h, 60)                 # present again: the pulse carries on
    assert [w["reasons"] for w in world.logged("wake")][2:] == [["pulse"], ["pulse"]]


def test_stepping_out_briefly_during_a_turn_is_still_not_an_event():
    def away(n):
        if n == 1:
            world.t = 5.0
            world.leave()
            world.t = 6.0                 # back within the 2 s grace
            world.enter()

    world, model, h = make(on_call=away)
    world.enter()
    h.step()
    assert not h.step()
    assert [w["reasons"] for w in world.logged("wake")] == [["arrival"]]


def test_world_closing_mid_turn_ends_the_session():
    script = [response(use("sense"), use("sense"))]
    world, model, h = make(script)
    world.close_on_call = True
    world.enter()
    h.step()
    kinds = [e["type"] for e in world.logged()]
    assert kinds[-2:] == ["turn_end", "close"]
    assert world.logged("close")[0]["reason"] == "window_closed"
    world.close_on_call = False
    world.say("hello")
    assert not h.step()
    assert len(model.sent) == 1


def test_only_an_empty_thinking_block_leaves_no_empty_message():
    script = [response(think("")), response(say(" "), use("sense")), response(think("", "s2"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    world.t = 12.0
    h.step()
    world.t = 24.0
    h.step()
    assert [e for e in world.logged("thought") if e["turn"] < 3] == []
    roles = [m["role"] for m in model.sent[-1]]
    assert roles == ["user", "assistant", "user"]   # unanswered wakes joined, roles alternate


# --- memory within the session ---------------------------------------------------

def test_thinking_unchanged_within_the_turn_and_text_after():
    script = [response(think("first idea", "sig-a"), say("hm"), use("sense")),
              response(think("second", "sig-b"), say("ok"))]
    world, model, h = make(script)
    world.enter()
    h.step()
    assert model.sent[1][1]["content"][0] == {"type": "thinking", "thinking": "first idea",
                                               "signature": "sig-a"}
    world.t = 12.0
    h.step()
    history = model.sent[2]
    assert history[1]["content"] == [say("first idea"), say("hm"), history[1]["content"][2]]
    assert history[3]["content"] == [say("second"), say("ok")]


def test_old_sense_results_fade_and_text_and_calls_stay():
    script = []
    for n in range(1, 10):
        script += [response(say(f"turn {n}"), use("sense")), response(say(f"end {n}"))]
    world, model, h = make(script)
    world.enter()
    for n in range(9):
        world.t = 12.0 * n
        h.step()

    def sense_results(messages):
        return [b["content"] for m in messages for b in m["content"] if b["type"] == "tool_result"]

    # First request of turn 8: turns 2..7 (the last six) in full, turn 1 faded.
    turn8 = model.sent[14]
    results = sense_results(turn8)
    assert results[0] == '{"t": 0.0, "faded": true}'
    assert all('"actual"' in r for r in results[1:])
    # Within turn 8 the history does not change between calls.
    assert model.sent[15][:len(turn8)] == turn8
    # Turn 9: turns 1 and 2 faded.
    results = sense_results(model.sent[16])
    assert results[:2] == ['{"t": 0.0, "faded": true}', '{"t": 12.0, "faded": true}']
    assert all('"actual"' in r for r in results[2:])
    # The agent's words and calls are all still there.
    words = [b["text"] for m in model.sent[16] for b in m["content"] if b["type"] == "text"]
    assert "turn 1" in words and "end 1" in words
    calls = [b for m in model.sent[16] for b in m["content"] if b["type"] == "tool_use"]
    assert len(calls) == 8


def test_memory_full_turns_zero_keeps_only_the_current_turn():
    script = [response(use("sense")), response(say("a")), response(use("sense")),
              response(say("b"))]
    world, model, h = make(script, Config(MEMORY_FULL_TURNS=0))
    world.enter()
    h.step()
    world.t = 12.0
    h.step()
    results = [b["content"] for m in model.sent[3] for b in m["content"] if b["type"] == "tool_result"]
    assert results[0] == '{"t": 0.0, "faded": true}'
    assert '"actual"' in results[1]


# --- remember ---------------------------------------------------------------------

def test_remember_counts_toward_the_cap_and_is_logged_without_tick(tmp_path):
    note = tmp_path / "note.txt"
    script = [response(use("remember", {"text": "flat at first"}), *[use("sense") for _ in range(8)])]
    world, model, h = make(script, Config(MEMORY_ENABLED=True), note_path=note)
    world.enter()
    h.step()
    assert note.read_text(encoding="utf-8") == "flat at first"
    assert len(world.body.calls) == 7
    remembered = [e for e in world.logged("call") if e["name"] == "remember"][0]
    assert "tick" not in remembered and remembered["result"] == {"ok": True, "t": 0.0}


def _run_with_real_world(model, until, max_wall_s=10.0):
    """The test's thread plays the window: tick after tick, a person present."""
    from lab.world import World

    world = World(Config())
    harness = Harness(world, model, world.config)
    harness.start()
    deadline = time.monotonic() + max_wall_s
    try:
        while not until(world) and time.monotonic() < deadline:
            world.tick(person=(3.5, 0.5))
            time.sleep(0.0005)
    finally:
        world.close()
        harness.stop()
    return world


def test_integration_clock_starts_at_arrival_and_the_session_replays(tmp_path):
    """body-contract.md: `t` is seconds since the session began, and the
    session begins when the person arrives. harness.md criterion 6: the log
    of a real session replays to the same body states with no model."""
    from lab.log import SessionLog, read_log
    from lab.model import ScriptedModel
    from lab.world import World, verify_log

    path = tmp_path / "session.jsonl"
    log = SessionLog(path)
    world = World(Config(), log)
    harness = Harness(world, ScriptedModel(world.config), world.config)
    harness.start()
    for _ in range(1000):                 # twenty seconds of open window; nobody has arrived
        world.tick(None)
    assert world.t == 0.0

    def turns_ended():
        return sum(e["type"] == "turn_end" for e in world.feed.since(0))

    deadline = time.monotonic() + 10.0
    while turns_ended() < 2 and time.monotonic() < deadline:
        world.tick(person=(3.5, 0.5), pressed=(2, 2) if world.body.tick % 300 > 250 else None)
        time.sleep(0.0005)
    world.close()
    harness.stop()
    log.close()

    events = read_log(path)
    wakes = [e for e in events if e["type"] == "wake"]
    # This loop ticks far faster than real time, so the mind thread notices the
    # arrival a few ticks late. What matters: the empty twenty seconds are not in `t`.
    assert json.loads(wakes[0]["message"]) == {"t": wakes[0]["t"]}
    assert wakes[0]["t"] < 5.0 and len(wakes) >= 2
    assert [e for e in events if e["type"] == "person"][0]["t"] == 0.0
    report = verify_log(path)
    assert report["ok"], report["mismatches"]
    assert report["calls"] >= 3


def test_integration_scripted_mind_moves_the_real_body():
    from lab.model import ScriptedModel

    def two_turns_and_raised(world):
        ends = [e for e in world.feed.since(0) if e["type"] == "turn_end"]
        return len(ends) >= 2 and world.t >= ends[1]["t"] + 3   # time for the rise

    world = _run_with_real_world(ScriptedModel(Config()), two_turns_and_raised)
    events = world.feed.since(0)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "header" and kinds.count("close") == 1
    after_close = kinds[kinds.index("close") + 1:]
    assert set(after_close) <= {"state", "person", "press"}   # nothing from the mind after it
    assert {"wake", "call", "turn_end", "thought"} <= set(kinds)
    calls = [e for e in events if e["type"] == "call"]
    assert all("tick" in e for e in calls)
    assert [e["name"] for e in calls][:3] == ["sense", "play", "sense"]
    assert calls[1]["result"]["ok"] is True and calls[1]["turn"] == 2
    actual = world.snapshot().actual
    assert max(max(row) for row in actual) > 0.5      # the checkerboard rose


def test_integration_body_keeps_ticking_while_the_model_thinks():   # harness.md criterion 2
    seen = []

    class Slow:
        name = "slow"

        def __init__(self):
            self.world = None

        def respond(self, system, tools, messages):
            before = world_ref[0].body.tick
            time.sleep(0.3)
            seen.append(world_ref[0].body.tick - before)
            return response(say("..."))

    world_ref = []

    def started(world):
        world_ref[:] = [world]
        return bool(seen)

    _run_with_real_world(Slow(), started)
    assert seen and seen[0] >= 20      # at least 20 ticks went by during one model call


def test_remember_does_not_exist_in_first_day_mode(tmp_path):
    note = tmp_path / "note.txt"
    note.write_text("old", encoding="utf-8")
    script = [response(use("remember", {"text": "new"}))]
    world, model, h = make(script, note_path=note)
    world.enter()
    h.step()
    assert note.read_text(encoding="utf-8") == "old"
    assert world.body.calls == [("remember", {"text": "new"})]   # the body answers it as unknown
