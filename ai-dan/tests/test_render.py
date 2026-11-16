"""Smoke tests for the window: drawing, layout, the feed reader, input and the command line.

Everything runs under SDL's dummy video driver, with no screen.
"""
import os

os.environ["SDL_VIDEODRIVER"] = "dummy"

import pygame  # noqa: E402
import pytest  # noqa: E402

from lab import render, shot  # noqa: E402
from lab.body import Snapshot  # noqa: E402
from lab.config import Config  # noqa: E402
from lab.log import Feed  # noqa: E402
from lab.render import Observer, View, draw, layout  # noqa: E402

SIZE = (1100, 760)


@pytest.fixture(autouse=True, scope="module")
def _pygame():
    pygame.init()
    yield
    pygame.quit()


def snap(actual, color=(255, 255, 255), person=None, pressed=None):
    return Snapshot(tick=0, t=0.0, rows=8, cols=8, target=actual, actual=actual,
                    gap_max=[[0.0] * 8 for _ in range(8)], color=color,
                    person=person, pressed=pressed)


def frame(s, view=None, size=SIZE):
    surf = pygame.Surface(size)
    lay = draw(surf, s, view or View(intro=0.0, clean=True))
    return surf, lay


def pin_pixel(surf, lay, r, c):
    x, y = lay.to_pixels((r + 0.5, c + 0.5))
    return surf.get_at((int(x), int(y)))[:3]


@pytest.mark.parametrize("name", shot.SCENES)
def test_every_scene_renders(name):
    surf = shot.render_scene(name, (960, 640))
    assert surf.get_size() == (960, 640)
    colors = {surf.get_at((x, y))[:3] for x in range(0, 960, 37) for y in range(0, 640, 29)}
    assert len(colors) > 5   # not an empty screen


def test_brightness_grows_with_height():
    heights = [i / 7 for i in range(8)]
    s = snap([list(heights) for _ in range(8)])
    surf, lay = frame(s)
    lum = [sum(pin_pixel(surf, lay, 4, c)) for c in range(8)]
    assert lum == sorted(lum) and lum[0] < lum[-1]


def test_flat_body_is_dark_but_visible():
    surf, lay = frame(snap([[0.0] * 8 for _ in range(8)]))
    floor = sum(surf.get_at((5, 5))[:3])
    pin = sum(pin_pixel(surf, lay, 3, 3))
    assert floor < pin < 3 * 60


def test_drawing_is_a_pure_function_of_state():
    s = snap(shot.swell(1.0), color=(120, 170, 255))
    a, _ = frame(s)
    b, _ = frame(s)
    assert pygame.image.tobytes(a, "RGB") == pygame.image.tobytes(b, "RGB")


def test_person_light_does_not_touch_the_pins():
    """The cursor is drawn on top, small; pins away from it are unchanged."""
    s = snap(shot.swell(1.0))
    lay = layout(SIZE, False)
    alone, _ = frame(s, View(intro=0.0, clean=True))
    visited, _ = frame(s, View(intro=0.0, clean=True, cursor=lay.to_pixels((10.0, 4.0))))
    for r in range(8):
        for c in range(8):
            assert pin_pixel(alone, lay, r, c) == pin_pixel(visited, lay, r, c)


def test_layout_maps_pixels_to_pin_units():
    lay = layout(SIZE, False)
    for pos in [(0, 0), (3.5, 5.25), (9.5, -1.0)]:
        back = lay.to_pin_units(lay.to_pixels(pos))
        assert back == pytest.approx(pos, abs=1e-6)
    assert lay.pin_at(lay.to_pixels((3.5, 5.5))) == (3, 5)
    assert lay.pin_at(lay.to_pixels((8.5, 2.0))) is None
    with_panel = layout(SIZE, True)
    assert with_panel.grid.right <= with_panel.panel.left


def test_observer_follows_the_feed():
    obs = Observer()
    feed = Feed()
    for ev in shot.STORY[:3]:
        feed.append(ev)
    obs.read(feed)
    assert obs.status == "awake" and obs.turn == 1
    feed.append({"type": "turn_end", "t": 4.0, "turn": 1, "tool_calls": 0})
    obs.read(feed)
    assert obs.status == "asleep"
    feed.append({"type": "close", "t": 9.0, "reason": "max_turns", "turns": 1})
    obs.read(feed)
    assert obs.status == "ended"
    assert Observer().status == "starting"


def test_repeated_api_errors_are_counted_and_cleared():
    obs = Observer()
    for i in range(3):
        obs.add({"type": "api_error", "t": 1.0, "turn": 1, "attempt": i + 1, "error": f"boom {i}"})
    assert obs.errors_in_a_row == 3 and obs.last_error == "boom 2"
    obs.add({"type": "usage", "t": 2.0, "turn": 1})
    assert obs.errors_in_a_row == 0


def test_panel_handles_odd_calls():
    """Calls come straight from a language model: anything can arrive."""
    events = [{"type": "call", "t": 1.0, "name": "play", "args": {"tracks": "nonsense"}, "result": {"ok": False, "error": "x"}},
              {"type": "call", "t": 1.0, "name": "play", "args": None, "result": None},
              {"type": "call", "t": 1.0, "name": "set_color", "args": {"rgb": "red"}, "result": {}},
              {"type": "call", "t": 1.0, "name": "stop", "args": {"pins": [[0, 0]]}, "result": {"ok": True}},
              {"type": "call", "t": 1.0, "name": "remember", "args": {"note": "x" * 900}, "result": {"ok": True}},
              {"type": "thought", "t": 1.0, "kind": "text", "text": "y" * 2000},
              {"type": "wake", "t": 1.0, "turn": 1, "message": "not json"}]
    frame(snap([[0.0] * 8 for _ in range(8)]), View(intro=0.0, panel=True, observer=shot.observer(events)))


# --- the app, with a stand-in world --------------------------------------
class FakeWorld:
    def __init__(self):
        self.config = Config()
        self.feed = Feed()
        self.ticks = []
        self.said = []
        self.k = 0
        self.heights = [[0.0] * 8 for _ in range(8)]   # what the body stands at; tests may change it

    @property
    def t(self):
        return self.k / 50

    def tick(self, person=None, pressed=None):
        self.ticks.append((person, pressed))
        self.k += 1

    def say(self, text):
        self.said.append(text)

    def snapshot(self):
        return snap(self.heights)


def run_app(script, frames=40):
    """Run the app headless; `script(frame_number, app)` may post events."""
    from lab import app as app_module

    world = FakeWorld()
    a = app_module.App(world, "live", frames=frames, size=SIZE)
    original = a._events
    count = {"n": 0}

    def events():
        count["n"] += 1
        script(count["n"], a)
        return original()

    a._events = events
    a.run()
    pygame.init()   # the app quits pygame on exit; the other tests still need it
    return world, a


def test_app_person_arrives_touches_speaks_and_leaves():
    lay = layout(SIZE, False)
    on_pin = tuple(int(v) for v in lay.to_pixels((2.5, 6.5)))

    def script(n, app):
        post = pygame.event.post
        if n == 5:
            post(pygame.event.Event(pygame.MOUSEMOTION, pos=on_pin, rel=(0, 0), buttons=(0, 0, 0)))
        if n == 10:
            post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=on_pin, button=1))
        if n == 15:
            post(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=on_pin, button=1))
            for ch in "hi a":
                post(pygame.event.Event(pygame.TEXTINPUT, text=ch))
            post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_BACKSPACE, mod=0, unicode="\b", scancode=0))
            post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_RETURN, mod=0, unicode="\r", scancode=0))
        if n == 20:
            post(pygame.event.Event(pygame.WINDOWLEAVE))
        if n == 30:   # Tab and F-keys never type
            post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_TAB, mod=0, unicode="\t", scancode=0))

    world, app = run_app(script)
    people = [p for p, _ in world.ticks]
    assert people[0] is None                                   # nobody before the mouse moves in
    assert any(p is not None and p[0] == pytest.approx(2.5, abs=0.05) for p in people)
    assert (2, 6) in [pressed for _, pressed in world.ticks]
    assert world.said == ["hi"]
    assert people[-1] is None                                  # gone after leaving the window
    assert app.view.panel is True and app.view.typing == ""


def test_escape_quits():
    def script(n, app):
        if n == 3:
            pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_ESCAPE, mod=0, unicode="\x1b", scancode=0))

    world, app = run_app(script, frames=1000)
    assert len(world.ticks) < 200


def test_dry_run_from_the_command_line(tmp_path, monkeypatch):
    import lab.log
    from lab.__main__ import main

    monkeypatch.setattr(lab.log, "new_log_path", lambda: tmp_path / "session.jsonl")
    out = tmp_path / "frame.png"
    assert main(["--dry-run", "--visitor", "--frames", "120", "--shot", str(out)]) == 0
    pygame.init()
    assert out.exists()
    lines = (tmp_path / "session.jsonl").read_text(encoding="utf-8").splitlines()
    assert '"mind": "scripted"' in lines[0]
    assert any('"type": "close"' in line for line in lines)


# --- the 3D view ---------------------------------------------------------
def view3d(**kw):
    return View(intro=0.0, clean=True, view3d=True, **kw)


def frame_bytes(s, view):
    surf, _ = frame(s, view)
    return pygame.image.tobytes(surf, "RGB")


def top_centre(lay, r, c, h):
    """The middle of pin (r, c)'s top face, as drawn at height h."""
    quad = next(q for kind, q in lay.camera.faces(r, c, h) if kind == "top")
    return (sum(x for x, _ in quad) / 4, sum(y for _, y in quad) / 4)


def test_3d_honesty_only_real_heights_and_colour_change_a_pin():
    base = snap(shot.swell(1.0), color=(120, 170, 255))
    ref = frame_bytes(base, view3d())
    other_target = [[0.9] * 8 for _ in range(8)]
    for changed in (
            Snapshot(**{**base.__dict__, "t": 99.0, "tick": 4950}),
            Snapshot(**{**base.__dict__, "person": (9.0, 4.0)}),
            Snapshot(**{**base.__dict__, "person": (3.0, 3.0), "pressed": (3, 3)}),
            Snapshot(**{**base.__dict__, "target": other_target}),
            Snapshot(**{**base.__dict__, "gap_max": other_target})):
        assert frame_bytes(changed, view3d()) == ref
    assert frame_bytes(snap(shot.swell(2.0), color=(120, 170, 255)), view3d()) != ref
    assert frame_bytes(snap(shot.swell(1.0), color=(255, 120, 120)), view3d()) != ref


def test_3d_brightness_grows_with_height():
    heights = [i / 7 for i in range(8)]
    surf, lay = frame(snap([list(heights) for _ in range(8)]), view3d())
    lum = []
    for c, h in enumerate(heights):
        x, y = top_centre(lay, 7, c, h)      # the front row: nothing stands in front of it
        lum.append(sum(surf.get_at((int(x), int(y)))[:3]))
    assert lum == sorted(lum) and lum[0] < lum[-1]


def test_3d_flat_body_is_dark_but_visible():
    surf, lay = frame(snap([[0.0] * 8 for _ in range(8)]), view3d())
    floor = sum(surf.get_at((5, 5))[:3])
    x, y = top_centre(lay, 3, 3, 0.0)
    pin = sum(surf.get_at((int(x), int(y)))[:3])
    assert floor < pin < 3 * 60


def test_3d_pixels_map_to_the_floor_and_back():
    lay = layout(SIZE, False, view3d=True)
    assert lay.camera is not None and layout(SIZE, False).camera is None
    for pos in [(0, 0), (3.5, 5.25), (9.5, -1.0), (4.0, 4.0)]:
        assert lay.to_pin_units(lay.to_pixels(pos)) == pytest.approx(pos, abs=1e-6)


@pytest.mark.parametrize("size", [(1280, 800), (960, 640), (1100, 760), (700, 700)])
@pytest.mark.parametrize("panel", [False, True])
def test_3d_body_stays_in_the_room_and_clear_of_the_panel(size, panel):
    lay = layout(size, panel, view3d=True)
    x, y, w, h = lay.camera.bounds()
    assert lay.room.left <= x and x + w <= lay.room.right
    assert 0 <= y and y + h <= lay.height
    if panel:
        assert x + w <= lay.panel.left


def test_3d_press_goes_to_the_pin_drawn_under_the_pointer():
    heights = [[0.0] * 8 for _ in range(8)]
    heights[3][4] = 1.0
    lay = layout(SIZE, False, view3d=True)
    lay.heights = heights
    tip = top_centre(lay, 3, 4, 1.0)
    assert lay.pin_at(tip) == (3, 4)
    floor_cell = tuple(int(v) for v in lay.to_pin_units(tip))
    assert floor_cell != (3, 4)                       # the cell behind the tall pin
    assert lay.touch(tip) == ((3, 4), 1.0)
    lay.heights = [[0.0] * 8 for _ in range(8)]       # the pin has sunk; the press stays
    assert lay.touch(tip, ((3, 4), 1.0)) == ((3, 4), 1.0)
    assert lay.touch(tip)[0] == floor_cell


def test_top_view_touch_is_unchanged():
    lay = layout(SIZE, False)
    px = lay.to_pixels((2.5, 6.5))
    assert lay.pin_at(px, hold=((5, 5), 1.0)) == (2, 6)       # a hold means nothing here
    assert lay.touch(px) == ((2, 6), 0.0)
    assert lay.touch(lay.to_pixels((9.0, 4.0))) is None


def f3(kind):
    return pygame.event.Event(kind, key=pygame.K_F3, mod=0, unicode="", scancode=0)


def test_f3_toggles_the_3d_view():
    def script(n, app):
        if n in (3, 6):
            pygame.event.post(f3(pygame.KEYDOWN))
            pygame.event.post(f3(pygame.KEYUP))
        if n == 5:
            assert app.view.view3d is True

    _, app = run_app(script, frames=10)
    assert app.view.view3d is False and app.layout.camera is None


def test_f3_held_down_switches_once():
    def script(n, app):
        if 3 <= n <= 8:              # the key repeats while held: KEYDOWN after KEYDOWN
            pygame.event.post(f3(pygame.KEYDOWN))
        if n == 9:
            assert app.view.view3d is True
            pygame.event.post(f3(pygame.KEYUP))
        if n == 11:
            pygame.event.post(f3(pygame.KEYDOWN))

    _, app = run_app(script, frames=14)
    assert app.view.view3d is False


def test_app_body_motion_never_moves_or_starts_a_press():
    """With the mouse still, a pin rising under the pointer neither takes over a
    press that began in a gap, nor starts one where there was none."""
    lay = layout(SIZE, False, view3d=True)
    gap = tuple(int(v) for v in lay.to_pixels((5.95, 2.5)))      # between rows 5 and 6, column 2
    behind = tuple(int(v) for v in lay.to_pixels((-0.6, 3.5)))   # just behind the back row
    assert lay.camera.covers(gap, 6, 2, 0.6) and lay.camera.covers(behind, 0, 3, 1.0)
    only = lambda pin, h: [[h if (r, c) == pin else 0.0 for c in range(8)] for r in range(8)]  # noqa: E731
    marks = {}

    def script(n, app):
        post = pygame.event.post
        marks[n] = len(app.world.ticks)
        if n == 1:
            post(f3(pygame.KEYDOWN))
        if n == 4:
            post(pygame.event.Event(pygame.MOUSEMOTION, pos=gap, rel=(0, 0), buttons=(0, 0, 0)))
            post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=gap, button=1))
        if n == 10:
            app.world.heights = only((6, 2), 0.6)
        if n == 16:
            app.world.heights = only((0, 3), 0.0)
            post(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=gap, button=1))
            post(pygame.event.Event(pygame.MOUSEMOTION, pos=behind, rel=(0, 0), buttons=(0, 0, 0)))
            post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=behind, button=1))
        if n == 22:
            app.world.heights = only((0, 3), 1.0)

    world, _ = run_app(script, frames=30)
    pressed = [p for _, p in world.ticks]
    assert set(pressed[marks[6]:marks[10]]) == {(5, 2)}
    assert set(pressed[marks[12]:marks[16]]) == {(5, 2)}     # the pin in front rose; the press stayed
    assert set(pressed[marks[18]:marks[22]]) == {None}       # behind the body: no press
    assert set(pressed[marks[24]:marks[29]]) == {None}       # a pin rose under the pointer: still none


def test_3d_replay_draws_a_visitor_far_in_front_of_the_body():
    """Far enough in front, a recorded visitor lands beyond the 3D camera, far off
    the screen. Drawing it must not fail."""
    for row in (20.0, 40.0, 1e6):
        s = snap([[0.0] * 8 for _ in range(8)], person=(row, 4.0))
        frame(s, View(mode="replay", intro=0.0, clean=True, view3d=True))


def test_app_press_in_3d_stays_on_its_pin_until_the_mouse_moves_away():
    lay = layout(SIZE, False, view3d=True)
    tall = [[0.0] * 8 for _ in range(8)]
    tall[3][4] = 1.0
    tip = tuple(int(v) for v in top_centre(lay, 3, 4, 1.0))
    far = tuple(int(v) for v in top_centre(lay, 6, 1, 0.0))
    marks = {}

    def script(n, app):
        post = pygame.event.post
        marks[n] = len(app.world.ticks)
        if n == 1:
            post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_F3, mod=0, unicode="", scancode=0))
        if n == 3:
            app.world.heights = tall
        if n == 6:
            post(pygame.event.Event(pygame.MOUSEMOTION, pos=tip, rel=(0, 0), buttons=(0, 0, 0)))
        if n == 8:
            post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=tip, button=1))
        if n == 14:
            app.world.heights = [[0.0] * 8 for _ in range(8)]   # it sinks under the finger
        if n == 20:
            post(pygame.event.Event(pygame.MOUSEMOTION, pos=far, rel=(0, 0), buttons=(1, 0, 0)))

    world, _ = run_app(script, frames=32)
    pressed = [p for _, p in world.ticks]
    assert set(pressed[marks[10]:marks[12]]) == {(3, 4)}
    assert set(pressed[marks[17]:marks[19]]) == {(3, 4)}      # still held after the drop
    assert set(pressed[marks[27]:marks[29]]) == {(6, 1)}      # moving away moves the press
