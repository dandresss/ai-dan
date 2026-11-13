"""The lab in a web page writes the same logs as this one.

web/tests/fixtures/js-session.jsonl was written by the JavaScript port
(web/lab/, made by web/tests/fixtures/make_js_session.js): a scripted person
and a scripted mind, no AI. Replayed here, every body call must answer as it
did in the browser and every state hash must match.
"""
import json
from dataclasses import fields
from pathlib import Path

from lab.analyze import analyze_file
from lab.config import Config
from lab.world import verify_log

JS_SESSION = Path(__file__).resolve().parent.parent / "web" / "tests" / "fixtures" / "js-session.jsonl"


def events():
    return [json.loads(line) for line in JS_SESSION.read_text(encoding="utf-8").splitlines()]


def test_a_session_from_the_browser_replays_to_the_same_body_states():
    report = verify_log(JS_SESSION)
    assert report["ok"], report["mismatches"]
    evs = events()
    body_calls = [e for e in evs if e["type"] == "call" and "tick" in e]
    states = [e for e in evs if e["type"] == "state"]
    assert report["calls"] == len(body_calls) > 10
    assert report["states"] == len(states) > 1
    assert report["ticks"] >= max(e["tick"] for e in evs if "tick" in e)


def test_every_line_is_exactly_what_json_dumps_writes():
    for line in JS_SESSION.read_text(encoding="utf-8").splitlines():
        assert json.dumps(json.loads(line), ensure_ascii=False) == line


def test_the_header_is_a_harness_header_with_this_labs_config():
    header = events()[0]
    assert list(header) == ["type", "version", "started_at", "config", "t", "prompt_version", "prompt",
                            "model", "tools", "memory_enabled", "mind"]
    assert list(header["config"]) == [f.name for f in fields(Config)]
    assert Config.from_dict(header["config"]) == Config()
    assert header["mind"] == "scripted" and header["model"] == "scripted"
    assert header["tools"] == ["play", "stop", "sense", "set_color"]


def test_the_analysis_reads_it_and_does_not_count_it():
    info = analyze_file(JS_SESSION)
    assert info["problems"] == []
    assert info["counted"] is False and "scripted" in info["reason"]
    assert info["turns"] == 5


def test_a_number_too_large_for_a_float_travels_as_infinity():
    plays = [e for e in events() if e["type"] == "call" and e["name"] == "play"]
    assert any(t.get("delay_s") == float("inf") for e in plays if isinstance(e["args"]["tracks"], list)
               for t in e["args"]["tracks"])
