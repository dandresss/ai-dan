"""Nervous system, acceptance criteria 1 to 7 of nervous-system.md."""
import pytest

from lab.config import Config
from lab.nervous import NervousSystem

ALL = list(range(64))


def track(keyframes, pins=ALL, loop=False, ease="smooth", delay_s=0.0):
    return {"pins": pins, "keyframes": keyframes, "loop": loop, "ease": ease, "delay_s": delay_s}


def make():
    return NervousSystem(Config())


def test_1_no_calls_all_heights_stay_zero():
    ns = make()
    for k in range(500):
        assert ns.heights(k / 50) == [0.0] * 64


def test_2_smooth_loop_is_an_exact_sinusoid():
    ns = make()
    ns.play([track([(0, 0.2), (2, 0.8), (4, 0.2)], loop=True)], 0.0)
    for second, expected in [(0, 0.2), (1, 0.5), (2, 0.8), (3, 0.5), (4, 0.2), (5, 0.5)]:
        assert ns.heights(float(second))[0] == pytest.approx(expected)


def test_3_track_without_loop_ends_and_holds_last_height():
    ns = make()
    ns.play([track([(0, 0.0), (1, 0.7)])], 0.0)
    assert ns.heights(0.5)[0] == pytest.approx(0.35)
    for t in (1.0, 1.02, 5.0, 100.0):
        assert ns.heights(t)[0] == pytest.approx(0.7)
    assert ns.pins[0].keyframes is None          # the track was released
    assert ns.pins[0].hold == pytest.approx(0.7)


def test_4_delay_holds_the_height_until_the_wait_is_over():
    ns = make()
    ns.play([track([(0, 0.0), (1, 0.6)])], 0.0)
    ns.heights(2.0)                              # first track finished at 0.6
    ns.play([track([(0, 0.1), (1, 0.9)], delay_s=3.0)], 2.0)
    for t in (2.0, 3.0, 4.9):
        assert ns.heights(t)[0] == pytest.approx(0.6)
    assert ns.heights(5.0)[0] == pytest.approx(0.1)
    assert ns.heights(6.0)[0] == pytest.approx(0.9)


def test_4_a_pin_named_twice_in_one_call_waits_at_the_height_it_had():
    # The last track wins, and during its wait the pin holds where it was
    # when the call arrived, not the first keyframe of the track it lost.
    ns = make()
    ns.play([track([(0, 1.0), (1, 1.0)]),
             track([(0, 0.5), (1, 0.5)], pins=[0], delay_s=5.0)], 0.0)
    for t in (0.0, 2.0, 4.9):
        assert ns.heights(t)[0] == pytest.approx(0.0)
        assert ns.heights(t)[1] == pytest.approx(1.0)
    assert ns.heights(5.0)[0] == pytest.approx(0.5)


def test_5_play_on_a_subset_leaves_the_other_pins_phase_untouched():
    plain, touched = make(), make()
    loop = track([(0, 0.2), (2, 0.8), (4, 0.2)], loop=True)
    plain.play([loop], 0.0)
    touched.play([loop], 0.0)
    touched.play([track([(0, 1.0), (1, 0.0)], pins=[0, 9], loop=True)], 1.3)
    for k in range(70, 400):
        a, b = plain.heights(k / 50), touched.heights(k / 50)
        assert [a[i] for i in ALL if i not in (0, 9)] == [b[i] for i in ALL if i not in (0, 9)]
        assert a[0] != b[0] or k == 0


def test_6_stop_freezes_each_pin_at_its_ordered_height_of_that_instant():
    ns = make()
    ns.play([track([(0, 0.2), (2, 0.8), (4, 0.2)], loop=True)], 0.0)
    ns.play([track([(0, 0.0), (1, 1.0)], pins=[3], ease="linear", loop=True)], 0.0)
    before = ns.heights(1.25)
    ns.stop([0, 3], 1.25)
    for t in (1.25, 2.0, 9.0):
        after = ns.heights(t)
        assert after[0] == pytest.approx(before[0])
        assert after[3] == pytest.approx(before[3]) == pytest.approx(0.25)
    assert ns.heights(2.0)[1] != before[1]       # a pin not named keeps moving


def test_7_same_calls_at_same_instants_give_same_heights():
    def run():
        ns = make()
        out = []
        for k in range(300):
            t = k / 50
            if k == 0:
                ns.play([track([(0, 0.1), (1, 0.9), (3, 0.3)], loop=True, ease="linear")], t)
            if k == 40:
                ns.play([track([(0, 0.5), (2, 0.0)], pins=[5, 6], delay_s=0.5)], t)
            if k == 120:
                ns.stop([5], t)
            out.append(ns.heights(t))
        return out
    assert run() == run()


def test_linear_is_constant_speed_and_smooth_is_slow_at_the_keyframes():
    ns = make()
    ns.play([track([(0, 0.0), (1, 1.0)], pins=[0], ease="linear"),
             track([(0, 0.0), (1, 1.0)], pins=[1], ease="smooth")], 0.0)
    assert ns.heights(0.25)[0] == pytest.approx(0.25)
    assert ns.heights(0.1)[1] < 0.1


def test_new_track_replaces_the_old_and_hold_is_where_the_pin_was():
    ns = make()
    ns.play([track([(0, 0.0), (1, 1.0)], ease="linear")], 0.0)
    ns.play([track([(0, 0.0), (1, 0.0)], delay_s=1.0)], 0.5)
    assert ns.heights(1.0)[0] == pytest.approx(0.5)
