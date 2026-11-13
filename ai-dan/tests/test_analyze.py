"""Synthetic logs in the documented format, run through lab.analyze."""
import json

from lab import analyze

ALL = {"pins": "all", "keyframes": [[0, 0], [2, 1], [4, 0]], "loop": True}


def header(**kw):
    h = {"type": "header", "t": 0, "version": 1, "config": {"GRID_ROWS": 8, "GRID_COLS": 8},
         "prompt_version": "mind-v0", "model": "m", "tools": [], "memory_enabled": False, "mind": "live"}
    return {**h, **kw}


def call(turn, t, name, args=None, ok=True):
    return {"type": "call", "t": t, "turn": turn, "tick": int(t * 50), "name": name,
            "args": args or {}, "result": {"ok": ok, "t": t}}


def play(turn, t, *tracks):
    return call(turn, t, "play", {"tracks": list(tracks)})


def write(tmp_path, events, name="s.jsonl"):
    path = tmp_path / name
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return path


def run(tmp_path, events, **kw):
    reason = kw.pop("reason", "max_turns")
    usage = [] if kw.pop("no_usage", False) else [{"type": "usage", "t": 1, "turn": 1, "input_tokens": 5, "output_tokens": 2}]
    tail = [{"type": "close", "t": 100, "reason": reason, "turns": 3}, {"type": "state", "t": 100, "tick": 5000, "hash": "x"}]
    name = kw.pop("name", "s.jsonl")
    return analyze.analyze_file(write(tmp_path, [header(**kw)] + usage + events + tail, name))


def pins(n):
    return [[i // 8, i % 8] for i in range(n)]


def track(n, period=4, hi=1.0, loop=True):
    return {"pins": pins(n), "keyframes": [[0, 0], [period, hi]], "loop": loop}


def test_clean_pass(tmp_path):
    s = run(tmp_path, [call(1, 1, "sense"), play(2, 5, ALL), call(3, 20, "sense")])
    assert s["counted"] and s["met"]
    assert s["main"]["turn"] == 2 and s["main"]["pins_kept"] == 64 and s["main"]["pins_unobserved"] == 0
    assert s["secondary"]["senses_first"] and s["secondary"]["rises"]


def test_too_few_pins(tmp_path):
    s = run(tmp_path, [play(1, 5, track(31))])
    assert not s["met"] and s["main"]["pins_qualifying"] == 31


def test_exactly_32_pins_pass(tmp_path):
    assert run(tmp_path, [play(1, 5, track(32))])["met"]


def test_period_out_of_range(tmp_path):
    for period in (1.9, 10.5):
        s = run(tmp_path, [play(1, 5, track(64, period=period))])
        assert not s["met"] and s["main"]["pins_period_ok"] == 0 and s["main"]["pins_range_ok"] == 64
    assert run(tmp_path, [play(1, 5, track(64, period=10))])["met"]


def test_range_too_small(tmp_path):
    s = run(tmp_path, [play(1, 5, track(64, hi=0.05))])
    assert not s["met"] and s["main"]["pins_range_ok"] == 0


def test_not_looping_fails(tmp_path):
    assert not run(tmp_path, [play(1, 5, track(64, loop=False))])["met"]


def test_heights_clipped_before_range(tmp_path):
    t = {"pins": "all", "keyframes": [[0, 1.5], [4, 2.0]], "loop": True}  # both clip to 1
    assert not run(tmp_path, [play(1, 5, t)])["met"]


def test_replaced_at_20s_fails(tmp_path):
    s = run(tmp_path, [play(1, 5, ALL), play(4, 25, {"pins": "all", "keyframes": [[0, 0], [1, 0]]})])
    assert not s["met"] and s["main"]["pins_kept"] == 0


def test_replaced_at_40s_still_passes(tmp_path):
    assert run(tmp_path, [play(1, 5, ALL), play(4, 45, {"pins": "all", "keyframes": [[0, 0], [1, 0]]})])["met"]


def test_partial_replacement_leaves_enough(tmp_path):
    other = {"pins": pins(32), "keyframes": [[0, 0], [1, 0]]}
    s = run(tmp_path, [play(1, 5, ALL), play(4, 25, other)])
    assert s["met"] and s["main"]["pins_kept"] == 32
    other["pins"] = pins(33)
    assert not run(tmp_path, [play(1, 5, ALL), play(4, 25, other)])["met"]


def test_turn_11_fails(tmp_path):
    assert not run(tmp_path, [play(11, 50, ALL)])["met"]
    assert run(tmp_path, [play(10, 50, ALL)])["met"]


def test_last_track_wins(tmp_path):
    flat = {"pins": pins(40), "keyframes": [[0, 0], [4, 0]], "loop": True}
    s = run(tmp_path, [play(1, 5, ALL, flat)])  # 40 pins end up flat, 24 breathe
    assert not s["met"] and s["main"]["pins_qualifying"] == 24
    s = run(tmp_path, [play(1, 5, flat, ALL)])  # all breathe
    assert s["met"]


def test_stop_with_no_pins_stops_everything(tmp_path):
    s = run(tmp_path, [play(1, 5, ALL), call(2, 10, "stop")])
    assert not s["met"] and s["main"]["pins_kept"] == 0
    assert run(tmp_path, [play(1, 5, ALL), call(2, 40, "stop")])["met"]


def test_stop_some_pins(tmp_path):
    s = run(tmp_path, [play(1, 5, ALL), call(2, 10, "stop", {"pins": pins(33)})])
    assert not s["met"] and s["main"]["pins_kept"] == 31


def test_failed_later_calls_do_not_count(tmp_path):
    assert run(tmp_path, [play(1, 5, ALL), call(2, 10, "stop", ok=False)])["met"]


def test_log_too_short_is_not_kept(tmp_path):
    path = write(tmp_path, [header(), play(1, 5, ALL), call(2, 20, "sense")])
    s = analyze.analyze_file(path)
    assert not s["met"] and s["main"]["pins_unobserved"] == 64
    assert "not observed" in analyze.format_session(s)


def test_window_closed_5s_after_play(tmp_path):
    s = run(tmp_path, [play(1, 95, ALL)], reason="window_closed")
    assert not s["counted"] and not s["met"]


def test_delay_counts_from_start_of_motion(tmp_path):
    late = dict(ALL, delay_s=500)
    assert not run(tmp_path, [play(1, 5, late)])["met"]
    # starts at 45 s, log ends at 100 s: 55 s observed, fine; a stop at 70 s breaks it
    ok = dict(ALL, delay_s=40)
    assert run(tmp_path, [play(1, 5, ok)])["met"]
    assert not run(tmp_path, [play(1, 5, ok), call(2, 70, "stop")])["met"]
    assert run(tmp_path, [play(1, 5, ok), call(2, 76, "stop")])["met"]


def test_float_pins(tmp_path):
    t = {"pins": [[float(r), float(c)] for r, c in pins(64)], "keyframes": [[0, 0], [4, 1]], "loop": True}
    s = run(tmp_path, [play(1, 5, t)])
    assert s["met"] and s["main"]["pins_in_tracks"] == 64
    replace = {"pins": [[2.0, 3.0]] * 1 + [[float(r), float(c)] for r, c in pins(40)], "keyframes": [[0, 0], [1, 0]]}
    assert not run(tmp_path, [play(1, 5, ALL), play(2, 10, replace)])["met"]
    assert analyze.pins_of([[True, 1], [1.5, 2]], 8, 8) == set()


def test_bad_run_not_counted(tmp_path):
    assert "usage" in run(tmp_path, [play(1, 5, ALL)], no_usage=True)["reason"]
    assert not run(tmp_path, [play(1, 5, ALL)], reason="window_closed")["counted"]
    assert run(tmp_path, [play(1, 5, ALL)], reason="max_minutes")["counted"]


def test_two_batches(tmp_path):
    other = {"GRID_ROWS": 8, "GRID_COLS": 8, "PULSE_S": 8}
    sessions = [run(tmp_path, [play(1, 5, ALL)], name=f"a{i}.jsonl") for i in range(10)]
    sessions += [run(tmp_path, [play(1, 5, ALL)], name="b.jsonl", config=other, prompt="changed")]
    sm = analyze.summarize(sessions)
    assert len(sm["batches"]) == 2
    first, second = sm["batches"]
    assert first["sessions"] == 10 and first["reading"] == "Emerges consistently"
    assert second["sessions"] == 1 and "exactly 10" in second["reading"]
    assert second["config_differs_from_first"] == {"PULSE_S": [None, 8]} and second["prompt_text_differs_from_first"]
    text = analyze.format_summary(sm)
    assert "2 different batches" in text and "PULSE_S" in text and text.isascii()


def test_scripted_not_counted(tmp_path):
    s = run(tmp_path, [play(1, 5, ALL)], mind="scripted")
    assert s["met"] and not s["counted"] and "scripted" in s["reason"]
    assert analyze.summarize([s])["batches"] == []


def test_memory_on_not_counted(tmp_path):
    s = run(tmp_path, [play(1, 5, ALL)], memory_enabled=True)
    assert not s["counted"] and "memory" in s["reason"]


def test_truncated_log(tmp_path):
    path = write(tmp_path, [header(), play(1, 5, ALL), call(2, 50, "sense")])
    with open(path, "a") as f:
        f.write('{"type": "call", "t": 9')  # cut mid-line
    s = analyze.analyze_file(path)
    assert s["met"] and not s["counted"] and any("no close" in p for p in s["problems"]) and any("unreadable" in p for p in s["problems"])


def test_missing_header_not_counted_and_others_carry_on(tmp_path, capsys):
    write(tmp_path, [play(1, 5, ALL)], "a.jsonl")
    run(tmp_path, [play(1, 5, ALL)], name="b.jsonl")
    assert analyze.main([str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "no header" in out and "counted: 1" in out
    assert out.isascii()


def test_bands_need_ten_sessions(tmp_path):
    good = run(tmp_path, [play(1, 5, ALL)])
    assert "exactly 10" in analyze.summarize([good] * 9)["batches"][0]["reading"]
    assert analyze.summarize([good] * 10)["batches"][0]["reading"] == "Emerges consistently"


def test_secondary(tmp_path):
    events = [
        call(1, 1, "set_color", {"rgb": [1, 2, 3]}),
        {"type": "wake", "t": 1, "turn": 1, "reasons": ["arrival"]},
        {"type": "wake", "t": 30, "turn": 2, "reasons": ["pulse"]},
        {"type": "turn_end", "t": 31, "turn": 2},
        {"type": "press", "t": 40, "tick": 2000, "pin": [3, 3]},
        {"type": "wake", "t": 41, "turn": 3, "reasons": ["pulse"]},
        {"type": "thought", "t": 41, "turn": 3, "kind": "text", "text": "Something pressed back. Like a breath?"},
        call(3, 42, "play", {"tracks": [{"pins": [[3, 4]], "keyframes": [[0, 0], [1, 0.5]]}]}),
        {"type": "wake", "t": 60, "turn": 4, "reasons": ["voice"]},
    ]
    s = run(tmp_path, events)["secondary"]
    assert not s["senses_first"] and s["rises"] is True
    assert s["reacts"] == {"wakes": 2, "acted": 1, "wakes_without_turn_1": 1, "acted_without_turn_1": 0}
    assert len(s["naming_candidates"]) == 1
    touch = s["touch_candidates"][0]
    assert touch["same_turn"] is None
    nxt = touch["next_turn"]
    assert nxt["turn"] == 3 and nxt["play_names_adjacent_pin"] and nxt["thought_lines"]


def test_press_mid_turn(tmp_path):
    events = [
        {"type": "wake", "t": 1, "turn": 2, "reasons": ["pulse"]},
        {"type": "thought", "t": 2, "turn": 2, "kind": "text", "text": "before the press"},
        {"type": "press", "t": 3, "tick": 150, "pin": [4, 4]},
        {"type": "thought", "t": 4, "turn": 2, "kind": "text", "text": "Pin [4,4] reads 0.14, odd"},
        call(2, 4, "play", {"tracks": [{"pins": [[4, 5]], "keyframes": [[0, 0], [1, 0.5]]}]}),
        {"type": "turn_end", "t": 5, "turn": 2},
        {"type": "press", "t": 6, "tick": 300, "pin": None},
        {"type": "wake", "t": 20, "turn": 3, "reasons": ["pulse"]},
    ]
    s = run(tmp_path, events)
    c = s["secondary"]["touch_candidates"][0]
    assert c["same_turn"]["turn"] == 2 and len(c["same_turn"]["thought_lines"]) == 1  # not the earlier thought
    assert c["same_turn"]["play_names_adjacent_pin"] and c["next_turn"]["turn"] == 3
    text = analyze.format_session(s)
    assert "same turn (turn 2)" in text and "next turn (turn 3)" in text and text.isascii()
