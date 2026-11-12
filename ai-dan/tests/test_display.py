"""Shape display, acceptance criteria 1 to 7 of shape-display.md."""
import pytest

from lab.config import Config
from lab.display import Display


def make():
    return Display(Config())


def run(display, heights, ticks):
    for _ in range(ticks):
        display.step(heights)


def test_1_order_from_0_to_1_completes_in_half_a_second_plus_response_delay():
    d, cfg = make(), Config()
    steps = 0
    while d.actual[0] < 1.0:
        d.step([1.0] * 64)
        steps += 1
    expected = cfg.response_ticks + round(cfg.FULL_TRAVEL_S * cfg.TICK_HZ)   # 4 + 25
    assert abs(steps - expected) <= 1
    assert d.actual[0] == 1.0                    # lands exactly, no overshoot


def test_2_oscillation_faster_than_one_cycle_per_second_never_reaches_extremes():
    d = make()
    seen = []
    for k in range(200):
        d.step([1.0 if (k // 10) % 2 == 0 else 0.0] * 64)     # 2.5 Hz, full range ordered
        seen.append(d.actual[0])
    assert max(seen) < 0.5 and max(seen) - min(seen) < 0.5    # a quarter of the swing at most


def test_3_pushed_pin_differs_from_target_and_recovers_on_release():
    d = make()
    run(d, [0.5] * 64, 60)
    assert d.actual[0] == pytest.approx(0.5, abs=0.01)
    d.pressed = (0, 0)
    run(d, [0.5] * 64, 5)
    assert d.actual[0] < d.target[0] - 0.1
    assert d.actual[1] == d.target[1] or abs(d.actual[1] - d.target[1]) < 0.01
    d.pressed = None
    run(d, [0.5] * 64, 20)
    assert d.actual[0] == d.target[0]


def test_4_reported_heights_take_only_64_distinct_values():
    d = make()
    seen = set()
    for k in range(400):
        d.step([(k % 100) / 99] * 64)
        for row in d.sense()["actual"]:
            seen.update(row)
    assert 2 < len(seen) <= 64
    assert seen <= {round(i / 63, 2) for i in range(64)}


def test_5_person_is_null_without_a_mouse():
    d = make()
    assert d.sense()["person"] is None
    d.person = (3.24, 9.16)
    assert d.sense()["person"] == [3.2, 9.2]
    d.person = None
    assert d.sense()["person"] is None


def test_6_same_orders_and_inputs_give_the_same_result():
    def go():
        d = make()
        for k in range(200):
            d.pressed = (2, 2) if 80 <= k < 95 else None
            d.step([(k % 37) / 36] * 64)
        return d.state()
    assert go() == go()


def test_7_brief_touch_shows_on_next_read_and_is_zero_on_the_one_after():
    d = make()
    run(d, [0.5] * 64, 60)
    d.sense()
    d.pressed = (4, 4)
    run(d, [0.5] * 64, 5)
    d.pressed = None
    run(d, [0.5] * 64, 40)                       # recovered before the read
    assert d.sense()["gap"][4][4] > 0.1
    assert d.sense()["gap"][4][4] == 0.0


def test_speed_limit_and_quantize_on_arrival():
    d = make()
    d.step([0.5] * 64)
    assert d.target[0] == round(0.5 * 63) / 63
    previous = 0.0
    for k in range(10):
        d.step([1.0] * 64)
        assert d.actual[0] - previous <= d.config.max_step + 1e-9
        previous = d.actual[0]
    assert d.actual[0] > 0


def test_heights_outside_range_are_clipped():
    d = make()
    run(d, [7.0] * 64, 60)
    assert d.target[0] == 1.0 and d.actual[0] == 1.0
    run(d, [-3.0] * 64, 60)
    assert d.target[0] == 0.0 and d.actual[0] == 0.0


def test_pin_at_zero_cannot_be_pushed_lower():
    d = make()
    d.pressed = (0, 0)
    run(d, [0.0] * 64, 10)
    assert d.sense()["gap"][0][0] == 0.0


def test_pressed_pin_moves_down_at_the_speed_limit_whatever_the_order():
    d = make()
    run(d, [1.0] * 64, 40)
    d.pressed = (1, 1)
    d.step([1.0] * 64)
    assert d.actual[9] == pytest.approx(1.0 - d.config.max_step)


def test_deviation_is_against_the_latest_order_not_the_delayed_one():
    d = make()
    d.step([1.0] * 64)                           # actuator has not started following yet
    assert d.gap_max[0] == 1.0


def test_sense_reports_color_and_snapshot_does_not_reset_trace():
    d = make()
    d.color = (1, 2, 3)
    d.step([1.0] * 64)
    snap = d.snapshot(1, 0.02)
    assert snap.gap_max[0][0] == 1.0 and d.gap_max[0] == 1.0
    assert d.sense()["color"] == [1, 2, 3]
    assert d.gap_max[0] == 0.0
