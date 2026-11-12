"""Body contract, acceptance criteria 1 to 5 of body-contract.md, and the validation table."""
import copy
import json
import math

import pytest

from lab.config import Config
from lab.simbody import SimBody

NO_POINT = "That point does not exist in your body."
TOO_MANY = "That is too many movements at once."
TOO_LONG = "That movement is too long to remember."
BAD_MOVE = "That movement cannot be understood."
BAD_COLOR = "That color cannot be understood."

KF = [[0, 0.2], [1, 0.8]]


def make():
    return SimBody(Config())


def run(body, ticks):
    for _ in range(ticks):
        body.step()


def play(body, **track):
    track.setdefault("pins", "all")
    track.setdefault("keyframes", KF)
    return body.call("play", {"tracks": [track]})


def test_1_all_pins_three_keyframes_loop_rise_and_fall_across_senses():
    body = make()
    assert play(body, keyframes=[[0, 0.1], [1, 0.9], [2, 0.1]], loop=True) == {"ok": True, "t": 0.0}
    seen = {}
    for k in range(1, 101):
        body.step()
        if k in (25, 50, 75, 100):
            seen[k] = body.call("sense")["actual"][0][0]
    assert seen[25] < seen[50] and seen[75] < seen[50] and seen[100] < seen[75]


def test_2_brief_touch_shows_in_next_gap_and_not_the_one_after():
    body = make()
    play(body, keyframes=[[0, 0.5], [1, 0.5]])
    run(body, 60)
    body.call("sense")
    body.set_pressed((2, 3))
    run(body, 5)
    body.set_pressed(None)
    run(body, 40)
    assert body.call("sense")["gap"][2][3] > 0.1
    assert body.call("sense")["gap"][2][3] == 0.0


def test_3_play_on_a_subset_does_not_alter_the_rest():
    def hashes_of_rest(second_call):
        body = make()
        play(body, keyframes=[[0, 0.2], [2, 0.8], [4, 0.2]], loop=True)
        out = []
        for k in range(200):
            if k == 70 and second_call:
                play(body, pins=[[0, 0]], keyframes=[[0, 1], [1, 0]], loop=True)
            body.step()
            snap = body.snapshot()
            out.append([v for r, row in enumerate(snap.actual) for c, v in enumerate(row) if (r, c) != (0, 0)])
        return out
    assert hashes_of_rest(False) == hashes_of_rest(True)


def test_4_invalid_call_returns_error_and_leaves_body_exactly_as_it_was():
    body = make()
    play(body, keyframes=[[0, 0.2], [2, 0.8]], loop=True)
    run(body, 30)
    before = body.state_hash()
    result = body.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": KF},
                                           {"pins": [[9, 9]], "keyframes": KF}]})
    assert result == {"ok": False, "t": 0.6, "error": NO_POINT}
    assert body.state_hash() == before
    for name, args in [("set_color", {"rgb": [1, 2, 300]}), ("stop", {"pins": [[0, 8]]}), ("dance", {})]:
        assert body.call(name, args)["ok"] is False
        assert body.state_hash() == before


def test_5_results_are_plain_json_with_no_simulator_detail():
    body = make()
    results = [play(body), body.call("stop", None), body.call("set_color", {"rgb": [1, 2, 3]}),
               body.call("sense"), play(body, keyframes=[[1, 0], [2, 1]])]
    for r in results:
        assert json.loads(json.dumps(r)) == r
    assert set(results[3]) == {"t", "actual", "gap", "person", "color"}
    assert len(results[3]["actual"]) == 8 and len(results[3]["actual"][0]) == 8
    assert results[4]["error"] == BAD_MOVE


# --- the error table --------------------------------------------------------
@pytest.mark.parametrize("track, message", [
    ({"pins": [[8, 0]], "keyframes": KF}, NO_POINT),
    ({"pins": [[0, 8]], "keyframes": KF}, NO_POINT),
    ({"pins": [[-1, 0]], "keyframes": KF}, NO_POINT),
    ({"pins": "all", "keyframes": [[0, 0]] * 17}, TOO_LONG),
    ({"pins": "all", "keyframes": [[0, 0], [601, 1]]}, TOO_LONG),
    ({"pins": "all", "keyframes": KF, "delay_s": 601}, TOO_LONG),
    ({"pins": "all", "keyframes": [[0, 0]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": []}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[1, 0], [2, 1]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [1, 1], [1, 0]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [2, 1], [1, 0]]}, BAD_MOVE),
    # shapes the table does not list
    ({"keyframes": KF}, BAD_MOVE),
    ({"pins": "some", "keyframes": KF}, BAD_MOVE),
    ({"pins": [], "keyframes": KF}, BAD_MOVE),
    ({"pins": [[0]], "keyframes": KF}, BAD_MOVE),
    ({"pins": [[0, 0.5]], "keyframes": KF}, BAD_MOVE),
    ({"pins": [[True, 0]], "keyframes": KF}, BAD_MOVE),
    ({"pins": [["0", 0]], "keyframes": KF}, BAD_MOVE),
    ({"pins": "all"}, BAD_MOVE),
    ({"pins": "all", "keyframes": "up"}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, "a"], [1, 1]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [1, float("nan")]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [float("inf"), 1]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [1, True]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": [[0, 0], [1]]}, BAD_MOVE),
    ({"pins": "all", "keyframes": KF, "delay_s": -1}, BAD_MOVE),
    ({"pins": "all", "keyframes": KF, "delay_s": "soon"}, BAD_MOVE),
    ({"pins": "all", "keyframes": KF, "ease": "bouncy"}, BAD_MOVE),
    ({"pins": "all", "keyframes": KF, "loop": "yes"}, BAD_MOVE),
    ({"pins": "all", "keyframes": KF, "loop": 1}, BAD_MOVE),
    ("not an object", BAD_MOVE),
])
def test_invalid_track_is_rejected_whole_with_the_exact_message(track, message):
    body = make()
    before = body.state_hash()
    result = body.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": KF}, track]})
    assert result == {"ok": False, "t": 0.0, "error": message}
    assert body.state_hash() == before


@pytest.mark.parametrize("args, message", [
    (None, BAD_MOVE), ({}, BAD_MOVE), ({"tracks": None}, BAD_MOVE), ({"tracks": []}, BAD_MOVE),
    ({"tracks": "x"}, BAD_MOVE), ("play", BAD_MOVE), ([], BAD_MOVE),
    ({"tracks": [{"pins": "all", "keyframes": KF}] * 17}, TOO_MANY),
])
def test_invalid_play_arguments(args, message):
    body = make()
    assert body.call("play", args) == {"ok": False, "t": 0.0, "error": message}


@pytest.mark.parametrize("rgb", [None, "red", [1, 2], [1, 2, 3, 4], [-1, 0, 0], [0, 0, 256], [1.5, 0, 0],
                                 [True, 0, 0], ["1", 2, 3], [math.nan, 0, 0], [math.inf, 0, 0], {"r": 1}])
def test_invalid_color(rgb):
    body = make()
    before = body.state_hash()
    assert body.call("set_color", {"rgb": rgb}) == {"ok": False, "t": 0.0, "error": BAD_COLOR}
    assert body.state_hash() == before
    assert body.call("set_color", None)["error"] == BAD_COLOR


def test_color_accepts_integral_floats_and_is_reported():
    body = make()
    assert body.call("set_color", {"rgb": [255.0, 0, 12]})["ok"] is True
    assert body.call("sense")["color"] == [255, 0, 12]


def test_stop_with_bad_pins_uses_the_play_messages():
    body = make()
    assert body.call("stop", {"pins": [[8, 8]]})["error"] == NO_POINT
    assert body.call("stop", {"pins": []})["error"] == BAD_MOVE
    assert body.call("stop", {"pins": "most"})["error"] == BAD_MOVE


def test_stop_without_pins_stops_every_pin_and_pins_none_too():
    for args in (None, {}, {"pins": None}, {"pins": "all"}):
        body = make()
        play(body, keyframes=[[0, 0], [10, 1]], ease="linear")
        run(body, 25)                             # 0.5 s: ordered 0.05
        assert body.call("stop", args)["ok"] is True
        run(body, 100)
        assert all(abs(v - 0.05) < 0.02 for row in body.snapshot().target for v in row)


def test_unknown_tool_and_unknown_extra_fields():
    body = make()
    assert body.call("fly", {}) == {"ok": False, "t": 0.0, "error": "That cannot be understood."}
    assert body.call("fly", None)["ok"] is False
    assert body.call(None, None)["ok"] is False
    assert play(body, extra="x", keyframes=KF)["ok"] is True
    assert body.call("sense", {"anything": 1})["t"] == 0.0


def test_integral_floats_accepted_as_pin_coordinates():
    body = make()
    assert play(body, pins=[[2.0, 3.0]])["ok"] is True


def test_heights_outside_range_are_clipped_not_errors():
    body = make()
    assert play(body, keyframes=[[0, -5], [1, 9]], ease="linear")["ok"] is True
    run(body, 120)
    assert body.snapshot().target[0][0] == 1.0


def test_same_pin_in_two_tracks_last_one_wins():
    body = make()
    body.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": [[0, 1], [1, 1]]},
                                  {"pins": [[0, 0]], "keyframes": [[0, 0.5], [1, 0.5]]}]})
    run(body, 5)
    assert body.snapshot().target[0][0] == round(0.5 * 63) / 63


def test_optional_fields_given_as_null_take_their_defaults():
    body = make()
    assert play(body, loop=None, ease=None, delay_s=None)["ok"] is True


def test_valid_limits_are_accepted():
    body = make()
    assert body.call("play", {"tracks": [{"pins": "all", "keyframes": KF}] * 16})["ok"] is True
    frames = [[i, 0.5] for i in range(16)]
    assert play(body, keyframes=frames, delay_s=600)["ok"] is True
    assert play(body, keyframes=[[0, 0], [600, 1]])["ok"] is True


def test_garbage_never_raises():
    body = make()
    junk = [None, 1, 1.5, "x", [], {}, [None], {"tracks": [None]}, {"tracks": [[]]}, {"tracks": [{}]},
            {"tracks": [{"pins": {}, "keyframes": {}}]}, {"rgb": {}}, {"pins": 10**400},
            {"tracks": [{"pins": "all", "keyframes": [[10**400, 0], [1, 1]]}]},
            {"tracks": [{"pins": [[10**400, 0]], "keyframes": KF}]}]
    for name in ("play", "stop", "sense", "set_color", "other", None, 5):
        for args in junk:
            result = body.call(name, copy.deepcopy(args))
            assert isinstance(result, dict)
