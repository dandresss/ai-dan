"""The window: input, the fixed-step loop and the frame.

The simulation runs in fixed 20 ms steps kept in line with the wall clock;
drawing runs at about 60 frames a second. The mouse is the person (position
and touch), typed characters are their voice. Letters are never shortcuts.
"""
from __future__ import annotations

import math
import time

import pygame

from .render import Observer, View, draw, forget_fonts, layout

STEP_S = 0.02            # one simulation tick
MAX_CATCH_UP = 10        # ticks per frame at most; a longer stall is dropped, not replayed
FPS = 60
INTRO_FADE_S = 1.2
SAID_FADE_S = 4.0
MAX_LINE = 200


class ScriptedVisitor:
    """A stand-in person for headless runs (`--visitor`): arrives after a
    second, circles the body slowly, says hello, then presses one pin."""

    def at(self, t: float) -> tuple:
        """(person, pressed, line to say or None) at `t` seconds after launch."""
        if t < 1.0:
            return None, None, None
        if 8.0 <= t < 10.0:
            return (4.5, 4.5), (4, 4), None
        a = 0.25 * (t - 1.0)
        person = (4.0 + 5.5 * math.cos(a), 4.0 + 5.5 * math.sin(a))
        say = "hello" if 5.0 <= t < 5.0 + STEP_S else None
        return person, None, say


class App:
    def __init__(self, world, mode: str = "live", *, log_path: str | None = None,
                 nokey_detail: str | None = None, replay_name: str | None = None,
                 speed: float = 1.0, frames: int | None = None, shot: str | None = None,
                 visitor: ScriptedVisitor | None = None, size: tuple = (1280, 800)):
        self.world = world
        self.replay = mode == "replay"
        self.speed = speed if self.replay else 1.0
        self.frames = frames
        self.shot = shot
        self.visitor = visitor
        self.size = size
        self.view = View(mode=mode, observer=Observer(), log_path=log_path,
                         nokey_detail=nokey_detail, replay_name=replay_name, speed=self.speed,
                         intro=0.0 if self.replay else 1.0)
        self.mouse: tuple | None = None   # window pixels, while the person is in the room
        self.button = False
        self.arrived = False
        self.fullscreen = False
        self.layout = layout(size, False)
        self.started = time.perf_counter()

    # --- input ------------------------------------------------------------
    def _person(self) -> tuple | None:
        if self.mouse is None:
            return None
        return self.layout.to_pin_units(self.mouse)

    def _pressed(self) -> tuple | None:
        if self.mouse is None or not self.button:
            return None
        return self.layout.pin_at(self.mouse)

    def _key(self, event) -> bool:
        """Handle a key press. Returns False to quit."""
        view = self.view
        key = event.key
        if key == pygame.K_ESCAPE:
            return False
        if key == pygame.K_TAB:
            view.panel = not view.panel
        elif key == pygame.K_F1:
            view.help = not view.help
        elif key == pygame.K_F2:
            view.clean = not view.clean
        elif key == pygame.K_F11:
            self._toggle_fullscreen()
        elif self.replay:
            if key == pygame.K_SPACE:
                view.paused = not view.paused
        elif key in (pygame.K_RETURN, pygame.K_KP_ENTER):
            line = view.typing.strip()
            if line:
                self.world.say(line)
                view.said, view.said_alpha = line, 1.0
            view.typing = ""
        elif key == pygame.K_BACKSPACE:
            view.typing = view.typing[:-1]
        return True

    def _toggle_fullscreen(self) -> None:
        if self.fullscreen:
            pygame.display.set_mode(self.size, pygame.RESIZABLE)
        else:
            self.size = pygame.display.get_surface().get_size()
            pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
        self.fullscreen = not self.fullscreen

    def _events(self) -> bool:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type == pygame.KEYDOWN:
                if not self._key(event):
                    return False
            elif event.type == pygame.TEXTINPUT and not self.replay:
                chars = "".join(ch for ch in event.text if ch.isprintable())
                self.view.typing = (self.view.typing + chars)[:MAX_LINE]
            elif event.type == pygame.MOUSEMOTION:
                # The person arrives the first time the mouse moves inside the window.
                self.mouse = event.pos
                self.arrived = True
            elif event.type == pygame.WINDOWLEAVE:
                self.mouse = None
                self.button = False
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                self.button = True
                self.mouse = event.pos
                self.arrived = True
            elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
                self.button = False
        return True

    # --- loop -------------------------------------------------------------
    def run(self) -> None:
        pygame.init()
        title = "A body to wake up in"
        if self.view.mode == "dryrun":
            title += "  (wiring test, not an AI)"
        elif self.replay:
            title += f"  (replay: {self.view.replay_name})"
        pygame.display.set_caption(title)
        screen = pygame.display.set_mode(self.size, pygame.RESIZABLE)
        pygame.mouse.set_visible(self.replay)   # live: the person is the light, not the arrow
        pygame.key.set_repeat(400, 35)
        pygame.key.start_text_input()
        clock = pygame.time.Clock()
        world, view = self.world, self.view

        backlog = 0.0
        last = time.perf_counter()
        frame = 0
        steps_run = 0   # the visitor's clock: the world's own starts only when someone arrives
        try:
            while self._events():
                now = time.perf_counter()
                dt = now - last
                last = now
                if not view.paused:
                    backlog += dt * self.speed

                cap = MAX_CATCH_UP * max(1, math.ceil(self.speed))
                steps = 0
                while backlog >= STEP_S and steps < cap:
                    if self.replay and world.done:
                        backlog = 0.0
                        break
                    person, pressed = self._person(), self._pressed()
                    if self.visitor is not None:
                        person, pressed, line = self.visitor.at(round(steps_run * STEP_S, 2))
                        if line:
                            world.say(line)
                            view.said, view.said_alpha = line, 1.0
                        self.arrived = self.arrived or person is not None
                    world.tick(person if self.arrived else None, pressed)
                    backlog -= STEP_S
                    steps += 1
                    steps_run += 1
                if steps >= cap:
                    backlog = min(backlog, STEP_S)

                view.observer.read(world.feed)
                if self.replay or self.arrived:
                    view.intro = max(0.0, view.intro - dt / INTRO_FADE_S)
                view.said_alpha = max(0.0, view.said_alpha - dt / SAID_FADE_S)
                if self.replay:
                    end = max(1, world.end_tick)
                    view.replay_progress = min(1.0, world.body.tick / end)
                    view.replay_total = end / world.config.TICK_HZ

                snap = world.snapshot()
                if self.visitor is not None:
                    self.mouse = None
                    if snap.person is not None:
                        self.mouse = self.layout.to_pixels(snap.person)
                view.cursor = self.mouse
                view.pressing = self.button or (self.visitor is not None and snap.pressed is not None)

                screen = pygame.display.get_surface()
                self.layout = draw(screen, snap, view)
                pygame.display.flip()
                frame += 1
                if self.frames is not None and frame >= self.frames:
                    break
                clock.tick(FPS)
            if self.shot:
                pygame.image.save(screen, self.shot)
        finally:
            forget_fonts()
            pygame.quit()
