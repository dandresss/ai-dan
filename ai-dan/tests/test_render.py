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

    @property
    def t(self):
        return self.k / 50

    def tick(self, person=None, pressed=None):
        self.ticks.append((person, pressed))
        self.k += 1

    def say(self, text):
        self.said.append(text)

    def snapshot(self):
        return snap([[0.0] * 8 for _ in range(8)])


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
