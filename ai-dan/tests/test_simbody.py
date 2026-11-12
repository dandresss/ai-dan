"""SimBody: tick order, snapshot, state hash, determinism."""
import pytest

from lab.config import Config
from lab.simbody import SimBody


def make():
    return SimBody(Config())


def test_starts_flat_and_still_and_time_follows_ticks():
    body = make()
    assert (body.tick, body.t) == (0, 0.0)
    for _ in range(50):
        body.step()
    assert (body.tick, body.t) == (50, 1.0)
    snap = body.snapshot()
    assert snap.actual == [[0.0] * 8] * 8 and snap.color == (255, 255, 255)
    assert snap.person is None and snap.pressed is None


def test_play_is_in_motion_within_the_same_step_it_arrived_in():
    body = make()
    body.call("play", {"tracks": [{"pins": "all", "keyframes": [[0, 0.8], [1, 0.8]]}]})
    body.step()
    assert body.snapshot().target[0][0] == round(0.8 * 63) / 63     # first keyframe, that very step
    assert body.snapshot().actual[0][0] == 0.0                     # the actuator has not started yet
    for _ in range(4):
        body.step()
    assert body.snapshot().actual[0][0] > 0


def test_call_time_is_the_tick_the_call_was_applied_in():
    body = make()
    for _ in range(25):
        body.step()
    assert body.call("stop", None)["t"] == 0.5
    assert body.call("sense")["t"] == 0.5


def test_snapshot_never_resets_the_trace_but_sense_does():
    body = make()
    body.call("play", {"tracks": [{"pins": [[1, 1]], "keyframes": [[0, 1], [1, 1]]}]})
    body.step()
    assert body.snapshot().gap_max[1][1] == 1.0
    assert body.snapshot().gap_max[1][1] == 1.0
    assert body.call("sense")["gap"][1][1] == 1.0
    assert body.snapshot().gap_max[1][1] == 0.0


def test_person_and_pressed_reach_snapshot_and_sense():
    body = make()
    body.set_person((3.24, 9.16))
    body.set_pressed((2, 5))
    snap = body.snapshot()
    assert snap.person == (3.24, 9.16) and snap.pressed == (2, 5)
    assert body.call("sense")["person"] == [3.2, 9.2]
    body.set_person(None)
    assert body.call("sense")["person"] is None


def _script(body, k):
    """A fixed scripted history, including a rejected call."""
    if k == 0:
        body.call("play", {"tracks": [{"pins": "all", "keyframes": [[0, 0.1], [1, 0.9], [2, 0.1]], "loop": True}]})
    if k == 30:
        body.set_person((2.0, 3.5))
    if k == 40:
        body.call("play", {"tracks": [{"pins": [[1, 1], [2, 2]], "keyframes": [[0, 1], [3, 0]], "delay_s": 1}]})
    if k == 60:
        body.set_pressed((1, 1))
    if k == 75:
        body.set_pressed(None)
    if k == 90:
        body.call("set_color", {"rgb": [10, 20, 30]})
    if k == 100:
        body.call("sense")
    if k == 110:
        body.call("play", {"tracks": [{"pins": [[9, 9]], "keyframes": [[0, 1], [1, 0]]}]})
    if k == 150:
        body.call("stop", {"pins": [[0, 0]]})


def test_determinism_two_bodies_identical_hash_at_every_tick():
    a, b = make(), make()
    for k in range(300):
        _script(a, k)
        _script(b, k)
        a.step()
        b.step()
        assert a.state_hash() == b.state_hash()


def test_state_hash_is_short_hex_and_differs_when_anything_differs():
    base = make()
    assert len(base.state_hash()) == 16
    int(base.state_hash(), 16)
    hashes = {base.state_hash()}

    def variant(act):
        body = make()
        act(body)
        return body.state_hash()

    hashes.add(variant(lambda b: b.step()))
    hashes.add(variant(lambda b: b.call("set_color", {"rgb": [0, 0, 0]})))
    hashes.add(variant(lambda b: b.set_pressed((0, 0))))
    hashes.add(variant(lambda b: b.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]]}]})))
    hashes.add(variant(lambda b: b.call("play", {"tracks": [{"pins": [[0, 1]], "keyframes": [[0, 0], [1, 1]]}]})))
    hashes.add(variant(lambda b: b.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": [[0, 0], [1, 1]],
                                                            "ease": "linear"}]})))
    assert len(hashes) == 7


def test_sense_changes_hash_only_through_the_trace():
    body = make()
    body.call("play", {"tracks": [{"pins": [[0, 0]], "keyframes": [[0, 1], [1, 1]]}]})
    body.step()
    before = body.state_hash()
    body.call("sense")
    assert body.state_hash() != before
    again = body.state_hash()
    body.call("sense")
    assert body.state_hash() == again


def test_world_runs_a_few_hundred_ticks():
    from lab.world import World
    world = World(Config())
    for _ in range(400):
        world.tick((4.0, 9.0), None)
    assert world.t == pytest.approx(8.0)
