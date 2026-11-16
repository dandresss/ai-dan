"""The fixed 3D view's camera: projection, the floor under the pointer, picking."""
import math

import pytest

from lab import camera
from lab.camera import Camera


def cam(rows=8, cols=8, center=(640, 384), height=535, max_width=1218.46):
    return Camera(rows, cols, center, height, max_width)


def flat(rows=8, cols=8, value=0.0):
    return [[value] * cols for _ in range(rows)]


def middle(quad):
    return (sum(x for x, _ in quad) / 4, sum(y for _, y in quad) / 4)


def test_floor_points_map_to_pixels_and_back():
    c = cam()
    for pos in [(0, 0), (3.5, 5.25), (9.5, -1.0), (-2.0, 4.0), (8, 8)]:
        assert c.floor(c.project(pos[1], pos[0], 0.0)) == pytest.approx(pos, abs=1e-6)


def test_the_body_is_fitted_and_centred():
    c = cam()
    x, y, w, h = c.bounds()
    assert h == pytest.approx(535)
    assert w < 1218.46
    assert (x + w / 2, y + h / 2) == pytest.approx((640, 384))
    narrow = cam(max_width=300)
    x, y, w, h = narrow.bounds()
    assert w == pytest.approx(300) and h < 535


def test_the_camera_is_in_front_and_above():
    c = cam()
    assert c.x == 4 and c.y > 8 and c.z > camera.RISE
    back = c.project(4, 0, 0)
    front = c.project(4, 8, 0)
    assert back[1] < front[1]                       # row 0 is at the back, higher on the screen
    assert c.project(0, 4, 0)[0] < c.project(8, 4, 0)[0]   # column 0 on the left, as in the top view
    assert c.project(4, 4, camera.RISE)[1] < c.project(4, 4, 0)[1]   # a raised pin rises on the screen
    left_back = c.project(0, 0, 0)[0]
    left_front = c.project(0, 8, 0)[0]
    assert left_front < left_back                  # perspective: the near edge is wider


def test_pins_are_drawn_back_to_front_and_outside_in():
    c = cam()
    order = c.order()
    assert sorted(order) == [(r, col) for r in range(8) for col in range(8)]
    assert [r for r, _ in order] == sorted(r for r, _ in order)
    assert [col for _, col in order[:8]] == [0, 7, 1, 6, 2, 5, 3, 4]


def test_each_pin_shows_the_faces_the_camera_can_see():
    c = cam()
    assert [k for k, _ in c.faces(3, 1, 0.5)] == ["right", "front", "top"]   # left of the camera
    assert [k for k, _ in c.faces(3, 6, 0.5)] == ["left", "front", "top"]    # right of it
    assert [k for k, _ in c.faces(3, 6, 0.0)] == ["top"]                     # flush with the plate
    odd = cam(rows=5, cols=7)
    assert [k for k, _ in odd.faces(2, 3, 1.0)] == ["front", "top"]          # straight ahead
    low = dict(c.faces(2, 2, 0.2))["front"]
    high = dict(c.faces(2, 2, 0.9))["front"]
    assert high[0][1] < low[0][1]                  # a taller pin has a taller front face


def test_heights_past_the_range_are_clipped():
    c = cam()
    assert c.faces(1, 1, 1.7) == c.faces(1, 1, 1.0)
    assert c.faces(1, 1, -0.4) == c.faces(1, 1, 0.0)
    assert camera.height([[None]], 0, 0) == 0.0
    assert camera.height([[0.3]], 4, 4) == 0.0


def test_a_press_goes_to_the_pin_drawn_under_the_pointer():
    c = cam()
    heights = flat()
    heights[6][2] = 1.0
    p = middle(dict(c.faces(6, 2, 1.0))["top"])
    assert c.floor(p)[0] < 6                       # the floor under its top belongs to a row behind it
    assert c.pick(p, heights) == (6, 2)
    front = middle(dict(c.faces(6, 2, 1.0))["front"])
    assert c.pick(front, heights) == (6, 2)


def test_a_held_press_stays_on_its_pin_while_it_sinks():
    c = cam()
    heights = flat()
    heights[6][2] = 1.0
    p = middle(dict(c.faces(6, 2, 1.0))["top"])
    heights[6][2] = 0.05                           # pushed down
    assert c.pick(p, heights) != (6, 2)
    assert c.pick(p, heights, ((6, 2), 1.0)) == (6, 2)
    heights[7][2] = 1.0                            # a neighbour in front rises over the pointer
    assert c.pick(p, heights, ((6, 2), 1.0)) == (6, 2)
    far = c.project(7.5, 0.5, 0.0)                 # the pointer moves well away
    assert c.pick(far, heights, ((6, 2), 1.0)) == (0, 7)


def test_a_press_in_a_gap_keeps_its_cell_whatever_rises_in_front():
    c = cam()
    heights = flat()
    gap = c.project(2.5, 5.95, 0.0)                # the plate between rows 5 and 6, in column 2
    assert c.pick(gap, heights) == (5, 2)
    heights[6][2] = 0.6                            # the pin in front rises over the pointer
    assert c.covers(gap, 6, 2, 0.6)
    assert c.pick(gap, heights) == (6, 2)          # a new press would land on it...
    assert c.pick(gap, heights, ((5, 2), 0.0)) == (5, 2)   # ...the one already there stays


def test_gaps_belong_to_a_pin_and_off_the_grid_is_nobody():
    c = cam()
    heights = flat()
    gap = c.project(3.0, 4.5, 0.0)                 # between columns 2 and 3, on the plate
    assert c.pick(gap, heights) in [(4, 2), (4, 3)]
    assert c.pick(c.project(-1.0, 4.0, 0.0), heights) is None
    assert c.pick(c.project(4.0, 9.5, 0.0), heights) is None


def test_a_ray_that_misses_the_floor_stops_far_away():
    c = cam()
    row, col = c.floor((640, -1e6))
    assert math.isfinite(row) and math.isfinite(col)
    dist = math.hypot(row - c.y, col - c.x)
    assert dist <= camera.FAR * c.distance + 1e-6
