"""Drawing the room: a pure function of a body snapshot and a little view state.

Nothing here opens a window or reads input, so the same code draws the live
window, the headless screenshots and the tests.

The honesty rule lives here. Every visual property of a pin (brightness,
size, glow, shadow) is computed from that pin's real height and the body's
colour, and from nothing else: no clocks, no noise, no light from the person.
If the body looks like it is breathing, the mind made it breathe.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import pygame

from .body import Snapshot

# --- palette -------------------------------------------------------------
ROOM_CENTER = (13, 13, 17)
ROOM_EDGE = (3, 3, 5)
PLATE = (11, 11, 14)
PLATE_EDGE = (22, 22, 27)
DORMANT = (25, 25, 30)          # a pin face at height 0, before the tint
TEXT = (206, 206, 214)
TEXT_DIM = (122, 122, 134)
TEXT_FAINT = (74, 74, 84)
PERSON = (255, 236, 214)
GHOST = (150, 175, 215)
WARN = (236, 170, 84)
AWAKE = (138, 214, 160)
ASLEEP = (110, 130, 180)
GONE = (100, 100, 108)
PANEL_BG = (9, 9, 12)
VOICE = (240, 200, 160)
THOUGHT = (186, 192, 214)

# --- fonts ---------------------------------------------------------------
_FAMILIES = {
    "sans": "segoeui,helveticaneue,helvetica,dejavusans,liberationsans,arial",
    "serif": "georgia,cambria,palatino,dejavuserif,liberationserif,timesnewroman",
    "mono": "consolas,menlo,sfmono,dejavusansmono,liberationmono,couriernew",
}
_fonts: dict = {}
_texts: dict = {}


def font(role: str, size: int, italic: bool = False) -> pygame.font.Font:
    size = max(11, size)
    key = (role, size, italic)
    if key not in _fonts:
        if not pygame.font.get_init():
            pygame.font.init()
        try:
            f = pygame.font.SysFont(_FAMILIES[role], size, italic=italic)
        except Exception:
            f = None
        if f is None:
            f = pygame.font.Font(None, int(size * 1.3))
            f.set_italic(italic)
        _fonts[key] = f
    return _fonts[key]


def forget_fonts() -> None:
    """Drop cached fonts and text; call before pygame.quit() (fonts die with it)."""
    _fonts.clear()
    _texts.clear()


def text(f: pygame.font.Font, s: str, color) -> pygame.Surface:
    """Rendered text, cached: the same strings are drawn 60 times a second."""
    key = (id(f), s, tuple(color))
    surf = _texts.get(key)
    if surf is None:
        if len(_texts) > 800:
            _texts.clear()
        surf = _texts[key] = f.render(s, True, color)
    return surf


def wrap(f: pygame.font.Font, s: str, width: int) -> list[str]:
    lines: list[str] = []
    for para in s.splitlines() or [""]:
        if f.size(para)[0] <= width:     # fits: keep its spacing as written
            lines.append(para)
            continue
        line = ""
        for word in para.split():
            while f.size(word)[0] > width and len(word) > 1:   # break very long words
                cut = len(word)
                while cut > 1 and f.size(word[:cut])[0] > width:
                    cut -= 1
                if line:
                    lines.append(line)
                    line = ""
                lines.append(word[:cut])
                word = word[cut:]
            trial = f"{line} {word}" if line else word
            if f.size(trial)[0] <= width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def clock(t: float) -> str:
    t = max(0, int(t))
    return f"{t // 60}:{t % 60:02d}"


def _mix(a, b, k: float):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


# --- reading the feed ----------------------------------------------------
class Observer:
    """Reads the event feed and keeps what the window shows of the mind:
    its state for the status line and the entries for the observer panel."""

    def __init__(self):
        self.index = 0
        self.header: dict | None = None
        self.status = "starting"     # starting, none, waiting, awake, asleep, ended
        self.turn = 0
        self.wake_t: float | None = None
        self.calls_this_turn = 0
        self.errors_in_a_row = 0
        self.last_error: str | None = None
        self.close: dict | None = None
        self.arrived = False
        self.entries: list[tuple[int, dict]] = []   # (sequence number, event)
        self._seq = 0

    @property
    def mind(self) -> str | None:
        return self.header.get("mind") if self.header else None

    def read(self, feed) -> None:
        events = feed.since(self.index)
        self.index += len(events)
        for ev in events:
            self.add(ev)

    def add(self, ev: dict) -> None:
        kind = ev.get("type")
        if kind == "header":
            self.header = ev
            self.status = "none" if ev.get("mind") == "none" else "waiting"
        elif kind == "person":
            if ev.get("pos") is not None:
                self.arrived = True
        elif kind == "wake":
            self.status = "awake"
            self.turn = ev.get("turn", self.turn + 1)
            self.wake_t = ev.get("t", 0.0)
            self.calls_this_turn = 0
            self._entry(ev)
        elif kind == "turn_end":
            if self.status != "ended":
                self.status = "asleep"
            self._entry(ev)
        elif kind == "close":
            self.status = "ended"
            self.close = ev
            self._entry(ev)
        elif kind == "api_error":
            self.errors_in_a_row += 1
            self.last_error = str(ev.get("error", ""))
            self._entry(ev)
        elif kind == "usage":
            self.errors_in_a_row = 0
        elif kind == "call":
            self.calls_this_turn += 1
            self._entry(ev)
        elif kind in ("thought", "voice"):
            self._entry(ev)

    def _entry(self, ev: dict) -> None:
        self._seq += 1
        self.entries.append((self._seq, ev))
        if len(self.entries) > 400:
            del self.entries[:100]


# --- view state ----------------------------------------------------------
@dataclass
class View:
    """Everything the drawing needs besides the body itself."""
    mode: str = "live"               # live, dryrun, replay, nokey
    observer: Observer = field(default_factory=Observer)
    panel: bool = False              # Tab
    help: bool = False               # F1
    clean: bool = False              # F2: no chrome
    intro: float = 1.0               # opacity of the title overlay
    typing: str = ""
    said: str = ""
    said_alpha: float = 0.0
    cursor: tuple | None = None      # live mouse in window pixels
    pressing: bool = False
    log_path: str | None = None
    nokey_detail: str | None = None  # why there is no mind, when it is not just the key
    replay_name: str | None = None
    replay_progress: float = 0.0
    replay_total: float = 0.0
    paused: bool = False
    speed: float = 1.0


@dataclass
class Layout:
    width: int
    height: int
    room: pygame.Rect
    grid: pygame.Rect
    pitch: float
    panel: pygame.Rect | None
    u: float                          # type scale

    def to_pin_units(self, px: tuple) -> tuple:
        """Window pixels -> (row, column) in pin units, past 0..8 in the margin."""
        return ((px[1] - self.grid.top) / self.pitch, (px[0] - self.grid.left) / self.pitch)

    def to_pixels(self, pos: tuple) -> tuple:
        return (self.grid.left + pos[1] * self.pitch, self.grid.top + pos[0] * self.pitch)

    def pin_at(self, px: tuple, rows: int = 8, cols: int = 8) -> tuple | None:
        r, c = self.to_pin_units(px)
        if 0 <= r < rows and 0 <= c < cols:
            return (int(r), int(c))
        return None


def layout(size: tuple, panel: bool, rows: int = 8, cols: int = 8) -> Layout:
    w, h = max(size[0], 200), max(size[1], 160)
    u = max(0.75, min(w / 1100, h / 760, 1.8))
    panel_rect = None
    room_w = w
    if panel:
        pw = int(min(max(w * 0.38, 340), w * 0.55))
        panel_rect = pygame.Rect(w - pw, 0, pw, h)
        room_w = w - pw
    room = pygame.Rect(0, 0, room_w, h)
    # The margin around the grid is where the person stands: keep it generous.
    pitch = min(room_w / (cols + 5.5), h / (rows + 5.0))
    gw, gh = int(pitch * cols), int(pitch * rows)
    grid = pygame.Rect(0, 0, gw, gh)
    grid.center = (room.centerx, int(h * 0.48))
    return Layout(w, h, room, grid, pitch, panel_rect, u)


# --- cached textures -----------------------------------------------------
_cache: dict = {}


def _radial(size: int, falloff: float = 2.2) -> pygame.Surface:
    """A white disc whose alpha fades from the centre: the base of every glow."""
    key = ("radial", size, falloff)
    if key not in _cache:
        surf = pygame.Surface((size, size), pygame.SRCALPHA)
        c = (size - 1) / 2
        for y in range(size):
            for x in range(size):
                d = math.hypot(x - c, y - c) / (size / 2)
                a = max(0.0, 1.0 - d) ** falloff
                surf.set_at((x, y), (255, 255, 255, int(255 * a)))
        _cache[key] = surf
    return _cache[key]


def _glow(diameter: int, rgb: tuple) -> pygame.Surface:
    """An additive glow sprite of a given colour (black = no light)."""
    key = ("glow", diameter, rgb)
    surf = _cache.get(key)
    if surf is None:
        if len(_cache) > 600:
            for k in [k for k in _cache if k[0] == "glow"]:
                del _cache[k]
        base = pygame.transform.smoothscale(_radial(64, 1.6), (diameter, diameter))
        surf = pygame.Surface((diameter, diameter))
        surf.fill((0, 0, 0))
        tinted = base.copy()
        tinted.fill((*rgb, 255), special_flags=pygame.BLEND_RGBA_MULT)
        surf.blit(tinted, (0, 0))
        _cache[key] = surf
    return surf


def _room(size: tuple) -> pygame.Surface:
    """Near-black floor, a touch lighter where the body is."""
    key = ("room", size)
    if key not in _cache:
        for k in [k for k in _cache if k[0] == "room"]:   # resizing: keep only the current size
            del _cache[k]
        sw, sh = 128, 80
        small = pygame.Surface((sw, sh))
        for y in range(sh):
            for x in range(sw):
                d = math.hypot((x - sw / 2) / (sw / 2), (y - sh * 0.48) / (sh / 2)) / 1.2
                small.set_at((x, y), _mix(ROOM_CENTER, ROOM_EDGE, min(1.0, d) ** 1.3))
        _cache[key] = pygame.transform.smoothscale(small, size)
    return _cache[key]


# --- the body ------------------------------------------------------------
def _height(snap: Snapshot, r: int, c: int) -> float:
    try:
        return min(1.0, max(0.0, float(snap.actual[r][c])))
    except (IndexError, TypeError, ValueError):
        return 0.0


def pin_face(h: float, tint: tuple) -> tuple:
    """Brightness grows with real height; at 0 the pin is dark but present."""
    dormant = _mix(DORMANT, tint, 0.05)
    lit = _mix(tint, (255, 255, 255), 0.12)
    return _mix(dormant, lit, h ** 1.25)


def draw_body(surf: pygame.Surface, snap: Snapshot, lay: Layout) -> None:
    p = lay.pitch
    rows, cols = snap.rows, snap.cols
    tint = tuple(int(min(255, max(0, v))) for v in snap.color)

    plate = lay.grid.inflate(int(p * 0.7), int(p * 0.7))
    pygame.draw.rect(surf, PLATE, plate, border_radius=int(p * 0.18))
    pygame.draw.rect(surf, PLATE_EDGE, plate, width=1, border_radius=int(p * 0.18))

    heights = [[_height(snap, r, c) for c in range(cols)] for r in range(rows)]

    def square(r, c, h, grow=1.0):
        side = p * (0.70 + 0.14 * h) * grow
        cx = lay.grid.left + (c + 0.5) * p
        cy = lay.grid.top + (r + 0.5) * p
        return pygame.Rect(round(cx - side / 2), round(cy - side / 2), round(side), round(side))

    # Shadows: a raised pin is lit from above-left and shades the plate.
    for r in range(rows):
        for c in range(cols):
            h = heights[r][c]
            if h > 0.01:
                rect = square(r, c, h).move(round(p * 0.07 * h), round(p * 0.11 * h))
                pygame.draw.rect(surf, _mix(PLATE, (0, 0, 0), 0.75 * min(1, h * 1.5)),
                                 rect, border_radius=max(1, int(p * 0.06)))

    # Glow: light from a raised pin spills onto the plate around it.
    gd = max(4, int(p * 2.4))
    for r in range(rows):
        for c in range(cols):
            h = heights[r][c]
            if h > 0.02:
                level = round(h ** 1.5 * 20) / 20          # quantised so sprites cache
                if level <= 0:
                    continue
                rgb = tuple(int(v * 0.30 * level) for v in tint)
                cx = lay.grid.left + (c + 0.5) * p
                cy = lay.grid.top + (r + 0.5) * p
                surf.blit(_glow(gd, rgb), (round(cx - gd / 2), round(cy - gd / 2)),
                          special_flags=pygame.BLEND_ADD)

    # Faces, with a thin lit edge that grows with height.
    radius = max(1, int(p * 0.06))
    for r in range(rows):
        for c in range(cols):
            h = heights[r][c]
            rect = square(r, c, h)
            face = pin_face(h, tint)
            pygame.draw.rect(surf, face, rect, border_radius=radius)
            edge = _mix(face, (255, 255, 255), 0.05 + 0.2 * h)
            pygame.draw.rect(surf, edge, rect, width=1, border_radius=radius)


def draw_person(surf, lay: Layout, px: tuple, pressing: bool, ghost: bool = False) -> None:
    p = lay.pitch
    x, y = int(px[0]), int(px[1])
    if ghost:
        r = max(5, int(p * 0.16))
        pygame.draw.circle(surf, _mix((0, 0, 0), GHOST, 0.55), (x, y), r, width=1)
        pygame.draw.circle(surf, GHOST, (x, y), 2)
        if pressing:
            pygame.draw.circle(surf, GHOST, (x, y), max(3, int(r * 0.55)), width=1)
        return
    d = max(16, int(p * (0.8 if pressing else 1.3)))
    halo = _radial(64, 2.8)
    halo = pygame.transform.smoothscale(halo, (d, d))
    tinted = halo.copy()
    tinted.fill((*PERSON, 170 if pressing else 110), special_flags=pygame.BLEND_RGBA_MULT)
    surf.blit(tinted, (x - d // 2, y - d // 2))
    pygame.draw.circle(surf, PERSON, (x, y), max(2, int(p * 0.035)))
    if pressing:   # a small mark at the fingertip
        pygame.draw.circle(surf, PERSON, (x, y), max(5, int(p * 0.13)), width=1)


# --- chrome --------------------------------------------------------------
def _blit_center(surf, s, cx, y, alpha=255):
    if alpha < 255:
        s = s.copy()
        s.set_alpha(alpha)
    surf.blit(s, (int(cx - s.get_width() / 2), int(y)))
    return s.get_height()


def _box(surf, rect, color=(8, 8, 11), alpha=225, border=PLATE_EDGE):
    shade = pygame.Surface(rect.size, pygame.SRCALPHA)
    pygame.draw.rect(shade, (*color, alpha), shade.get_rect(), border_radius=8)
    surf.blit(shade, rect.topleft)
    if border:
        pygame.draw.rect(surf, border, rect, width=1, border_radius=8)


def _lines_box(surf, lay, lines, cx, top, accent=None, alpha=255, max_w=None):
    """A calm box of text lines: [(font, text, color), ...]. Returns its rect."""
    pad = int(16 * lay.u)
    max_w = max_w or int(min(lay.room.width - 40, 640 * lay.u))
    rendered = []
    for f, s, color in lines:
        if s == "":
            rendered.append(int(f.get_linesize() * 0.5))
            continue
        for line in wrap(f, s, max_w - 2 * pad):
            rendered.append(text(f, line, color))
    w = max([r.get_width() for r in rendered if not isinstance(r, int)] + [0]) + 2 * pad
    h = sum(r if isinstance(r, int) else r.get_height() + 2 for r in rendered) + 2 * pad
    rect = pygame.Rect(0, 0, w, h)
    rect.midtop = (cx, top)
    layer = pygame.Surface(rect.size, pygame.SRCALPHA)
    pygame.draw.rect(layer, (8, 8, 11, 232), layer.get_rect(), border_radius=8)
    pygame.draw.rect(layer, (*(accent or PLATE_EDGE), 255), layer.get_rect(), width=1, border_radius=8)
    y = pad
    for r in rendered:
        if isinstance(r, int):
            y += r
            continue
        layer.blit(r, (pad, y))
        y += r.get_height() + 2
    if alpha < 255:
        layer.set_alpha(alpha)
    surf.blit(layer, rect.topleft)
    return rect


def draw_intro(surf, lay: Layout, view: View) -> None:
    a = max(0.0, min(1.0, view.intro))
    if a <= 0.01:
        return
    u = lay.u
    scrim = pygame.Surface(lay.room.size, pygame.SRCALPHA)
    scrim.fill((2, 2, 4, int(200 * a)))
    surf.blit(scrim, lay.room.topleft)
    cx = lay.room.centerx
    alpha = int(255 * a)
    title = text(font("serif", int(46 * u)), "A body to wake up in", (232, 230, 236))
    sub_f = font("sans", int(18 * u))
    lines = [
        "An AI wakes up inside this surface of 64 pins. Nobody has told it what it is.",
    ]
    how_f = font("sans", int(16 * u))
    how = [
        ("arrive", "Move the mouse into the room."),
        ("touch", "Hold the button down on the body."),
        ("speak", "Type, then press Enter."),
        ("go", "Leave the window."),
    ]
    block_h = title.get_height() + int(70 * u) + len(how) * int(30 * u)
    y = lay.grid.centery - block_h / 2 - int(10 * u)
    y += _blit_center(surf, title, cx, y, alpha) + int(10 * u)
    for line in lines:
        for part in wrap(sub_f, line, int(lay.room.width * 0.8)):
            y += _blit_center(surf, text(sub_f, part, TEXT_DIM), cx, y, alpha)
    y += int(26 * u)
    key_f = font("sans", int(13 * u))
    col = int(84 * u)
    for key, what in how:
        k = text(key_f, key.upper(), TEXT_FAINT)
        s = text(how_f, what, TEXT)
        x = cx - int(150 * u)
        ks, ss = k.copy(), s.copy()
        ks.set_alpha(alpha)
        ss.set_alpha(alpha)
        surf.blit(ks, (x + col - ks.get_width() - int(14 * u), y + (ss.get_height() - ks.get_height()) / 2 + 1))
        surf.blit(ss, (x + col, y))
        y += int(30 * u)


def draw_status(surf, lay: Layout, snap: Snapshot | None, view: View) -> None:
    obs = view.observer
    u = lay.u
    f = font("sans", int(14 * u))
    t = snap.t if snap else 0.0
    status, color, detail = mind_status(obs, t, view)
    x = int(22 * u)
    y = lay.height - int(30 * u)
    pygame.draw.aacircle(surf, color, (x + 4, y + f.get_linesize() // 2), max(3, int(3.5 * u)))
    x += int(16 * u)
    parts = [clock(t)]
    if obs.turn:
        parts.append(f"turn {obs.turn}")
    parts.append(status)
    s = text(f, "   ·   ".join(parts), TEXT_DIM)
    surf.blit(s, (x, y))
    keys = "Tab observer    F1 help" if not view.panel else "F1 help"
    k = text(font("sans", int(13 * u)), keys, TEXT_FAINT)
    kx = lay.room.right - k.get_width() - int(22 * u)
    surf.blit(k, (kx, y + 1))
    if detail:
        d = text(f, "   " + detail, TEXT_FAINT)
        if x + s.get_width() + d.get_width() < kx - int(20 * u):
            surf.blit(d, (x + s.get_width(), y))


def mind_status(obs: Observer, t: float, view: View) -> tuple:
    """(word, colour, detail) for the status line."""
    if obs.status == "ended":
        return "gone", GONE, "the session has ended"
    if view.mode == "nokey" or obs.status == "none":
        return "no mind", GONE, "the body is here, but nothing will wake in it"
    if obs.status == "starting":
        return "starting", TEXT_FAINT, ""
    if obs.status == "waiting":
        return "not yet awake", ASLEEP, "it wakes when someone arrives"
    if obs.status == "awake":
        waited = max(0.0, t - (obs.wake_t or 0.0))
        if obs.errors_in_a_row:
            return "awake", WARN, f"the model did not answer, retrying ({obs.errors_in_a_row})"
        if obs.calls_this_turn == 0:
            note = "thinking"
            if waited > 2:
                note += f"  {int(waited)} s"
            if obs.turn <= 1 and waited > 2:
                note += "  (a first thought takes a few seconds)"
            elif waited > 40:
                note += "  (longer than usual)"
            return "awake", AWAKE, note
        return "awake", AWAKE, f"{obs.calls_this_turn} call{'s' if obs.calls_this_turn != 1 else ''} this turn"
    if obs.status == "asleep":
        pulse = ((obs.header or {}).get("config") or {}).get("PULSE_S")
        every = f"every {pulse:g} s" if isinstance(pulse, (int, float)) else "every few seconds"
        return "asleep", ASLEEP, f"it wakes when you speak, arrive or leave, and {every} while you are here"
    return obs.status, TEXT_FAINT, ""


def draw_typing(surf, lay: Layout, view: View) -> None:
    u = lay.u
    f = font("sans", int(18 * u))
    cx = lay.room.centerx
    y = lay.grid.bottom + int(lay.pitch * 0.9)
    if view.said and view.said_alpha > 0.02:
        _blit_center(surf, text(f, f"“{view.said}”", VOICE), cx,
                     y - int(28 * u), int(200 * view.said_alpha))
    if view.typing:
        s = text(f, view.typing, TEXT)
        w = s.get_width()
        surf.blit(s, (cx - w // 2, y))
        caret_x = cx + w // 2 + 3
        pygame.draw.line(surf, TEXT_DIM, (caret_x, y + 3), (caret_x, y + s.get_height() - 3))
        hint = text(font("sans", int(12 * u)), "Enter to say it", TEXT_FAINT)
        _blit_center(surf, hint, cx, y + s.get_height() + 4)
    elif view.intro < 0.05 and view.mode != "replay" and view.observer.status != "ended":
        _blit_center(surf, text(font("sans", int(13 * u)), "type to speak", TEXT_FAINT), cx, y + 4)


def is_wiring_test(view: View) -> bool:
    """A dry run, or a replay of one: it must never pass for an AI."""
    return view.mode == "dryrun" or view.observer.mind == "scripted"


def draw_banners(surf, lay: Layout, snap: Snapshot | None, view: View) -> None:
    """Mode labels at the top of the room, and calm messages for odd states."""
    u = lay.u
    cx = lay.room.centerx
    top = int(18 * u)
    obs = view.observer

    if is_wiring_test(view):
        f = font("sans", int(15 * u))
        label = text(f, "WIRING TEST   ·   a scripted pattern, not an AI", (24, 16, 6))
        rect = label.get_rect().inflate(int(28 * u), int(12 * u))
        rect.midtop = (cx, top)
        pygame.draw.rect(surf, WARN, rect, border_radius=rect.height // 2)
        surf.blit(label, label.get_rect(center=rect.center))
        top = rect.bottom + int(10 * u)

    if view.mode == "replay":
        f = font("sans", int(14 * u))
        state = "paused" if view.paused else (f"x{view.speed:g}" if view.speed != 1 else "")
        now = snap.t if snap else 0.0
        words = ["REPLAY", view.replay_name or "", f"{clock(now)} / {clock(view.replay_total)}"]
        if state:
            words.append(state)
        if view.replay_progress >= 1:
            words.append("end of recording")
        label = text(f, "   ·   ".join(words), (200, 212, 236))
        rect = label.get_rect().inflate(int(28 * u), int(16 * u))
        rect.midtop = (cx, top)
        _box(surf, rect, border=_mix((0, 0, 0), GHOST, 0.5))
        surf.blit(label, (rect.x + int(14 * u), rect.y + int(6 * u)))
        bar = pygame.Rect(rect.x + int(14 * u), rect.bottom - int(5 * u), rect.width - int(28 * u), 2)
        pygame.draw.rect(surf, (36, 40, 52), bar)
        bar.width = int(bar.width * max(0.0, min(1.0, view.replay_progress)))
        pygame.draw.rect(surf, GHOST, bar)
        top = rect.bottom + int(10 * u)
        hint = text(font("sans", int(12 * u)), "Space pauses   ·   the ring is the recorded visitor", TEXT_FAINT)
        _blit_center(surf, hint, cx, top)

    if view.mode == "nokey":
        f = font("sans", int(15 * u))
        mono = font("mono", int(13 * u))
        lines = [(f, "No mind is connected. The body is here, but nothing will wake in it: "
                     + (view.nokey_detail or "no Anthropic API key was found."), TEXT),
                 (font("sans", int(13 * u)), "To wake it, copy .env.example to .env, add your key "
                  "after ANTHROPIC_API_KEY= and start again. Without a key:", TEXT_DIM),
                 (mono, "python -m lab --dry-run   |   python -m lab --replay FILE", TEXT_DIM)]
        top = _lines_box(surf, lay, lines, cx, top, accent=(52, 52, 60),
                         max_w=int(min(lay.room.width - 40, 760 * u))).bottom + int(10 * u)

    if obs.errors_in_a_row >= 2 and obs.status != "ended":
        f = font("sans", int(14 * u))
        lines = [(f, f"The mind cannot be reached right now ({obs.errors_in_a_row} failed attempts). "
                     "The body is fine and keeps going.", WARN),
                 (font("mono", int(13 * u)), (obs.last_error or "")[:300], TEXT_DIM)]
        _lines_box(surf, lay, lines, cx, top, accent=_mix((0, 0, 0), WARN, 0.6))

    if obs.status == "ended" and view.mode != "replay":
        f = font("sans", int(15 * u))
        mono = font("mono", int(13 * u))
        reason = (obs.close or {}).get("reason", "")
        why = {"max_turns": "it used all of its turns",
               "max_minutes": "the session reached its time limit",
               "window_closed": "the window is closing"}.get(reason, reason)
        lines = [(f, "The mind has gone quiet" + (f": {why}." if why else ".")
                  + " The body stays as it was left.", TEXT)]
        if view.log_path:
            lines += [(mono, f"log      {view.log_path}", TEXT_DIM),
                      (mono, f"analyse  python -m lab.analyze {view.log_path}", TEXT_DIM),
                      (mono, f"replay   python -m lab --replay {view.log_path}", TEXT_DIM)]
        _lines_box(surf, lay, lines, cx, lay.grid.bottom + int(lay.pitch * 0.55),
                   max_w=int(min(lay.room.width - 40, 760 * u)))


def draw_help(surf, lay: Layout, view: View) -> None:
    u = lay.u
    f = font("sans", int(15 * u))
    dim = font("sans", int(14 * u))
    rows = [("mouse", "move in the room; hold the button on a pin to press it"),
            ("typing", "your voice; Enter says the line, Backspace edits"),
            ("Tab", "observer panel: the mind's private side"),
            ("F1", "this help"),
            ("F2", "hide all text, for clean recordings"),
            ("F11", "fullscreen"),
            ("Esc", "leave and close")]
    if view.mode == "replay":
        rows[1] = ("Space", "pause or resume the replay")
    pad, gap = int(20 * u), int(18 * u)
    key_w = max(dim.size(k)[0] for k, _ in rows)
    val_w = max(dim.size(v)[0] for _, v in rows)
    line = dim.get_linesize() + int(4 * u)
    foot = text(dim, "Letters are never shortcuts: typing is how you speak to it.", TEXT_FAINT)
    w = max(key_w + gap + val_w, foot.get_width()) + 2 * pad
    h = 2 * pad + f.get_linesize() + int(10 * u) + len(rows) * line + int(12 * u) + foot.get_height()
    rect = pygame.Rect(0, 0, w, h)
    rect.center = (lay.room.centerx, lay.grid.centery)
    _box(surf, rect, alpha=242)
    x, y = rect.x + pad, rect.y + pad
    surf.blit(text(f, "Keys", TEXT), (x, y))
    y += f.get_linesize() + int(10 * u)
    for k, v in rows:
        surf.blit(text(dim, k, TEXT), (x, y))
        surf.blit(text(dim, v, TEXT_DIM), (x + key_w + gap, y))
        y += line
    surf.blit(foot, (x, y + int(12 * u)))


# --- observer panel ------------------------------------------------------
def _play_summary(args) -> tuple[str, list]:
    tracks = args.get("tracks") if isinstance(args, dict) else None
    if not isinstance(tracks, list):
        return "play", []
    parts, curves = [], []
    for tr in tracks:
        if not isinstance(tr, dict):
            continue
        pins = tr.get("pins")
        n = 64 if pins == "all" else (len(pins) if isinstance(pins, list) else "?")
        kfs = tr.get("keyframes") if isinstance(tr.get("keyframes"), list) else []
        try:
            period = float(kfs[-1][0])
            pts = [(float(k[0]), float(k[1])) for k in kfs]
        except (IndexError, TypeError, ValueError):
            period, pts = None, []
        bits = [f"{n} pin{'s' if n != 1 else ''}"]
        bits.append("loop" if tr.get("loop") else "once")
        if period:
            bits.append(f"{period:g} s")
        if tr.get("delay_s"):
            bits.append(f"after {tr['delay_s']:g} s" if isinstance(tr["delay_s"], (int, float)) else "delayed")
        parts.append(" ".join(bits))
        curves.append(pts)
    more = f" (+{len(parts) - 3} more)" if len(parts) > 3 else ""
    return f"play  {len(parts)} track{'s' if len(parts) != 1 else ''}: " + ";  ".join(parts[:3]) + more, curves[:4]


def _call_line(ev: dict) -> tuple[str, list, tuple | None]:
    """(text, keyframe curves, colour swatch) for one call."""
    name = ev.get("name", "?")
    args = ev.get("args") or {}
    res = ev.get("result") or {}
    if name == "play":
        line, curves = _play_summary(args)
        return line, curves, None
    if name == "sense":
        bits = ["sense"]
        if isinstance(res, dict) and "actual" in res:
            try:
                cells = [v for row in res["actual"] for v in row]
                bits.append(f"height {min(cells):.2f}-{max(cells):.2f}")
                bits.append(f"gap max {max(v for row in res.get('gap', [[0]]) for v in row):.2f}")
            except (TypeError, ValueError):
                pass
            person = res.get("person")
            bits.append(f"person {person}" if person else "nobody")
        return " · ".join(bits), [], None
    if name == "set_color":
        rgb = args.get("rgb") if isinstance(args, dict) else None
        try:
            sw = tuple(int(min(255, max(0, v))) for v in rgb[:3])
        except (TypeError, ValueError):
            sw = None
        return f"set_color  {rgb}", [], sw
    if name == "stop":
        pins = args.get("pins") if isinstance(args, dict) else None
        what = "all pins" if pins in (None, "all") else f"{len(pins) if isinstance(pins, list) else '?'} pins"
        return f"stop  {what}", [], None
    if name == "remember":
        value = next((v for v in (args.values() if isinstance(args, dict) else []) if isinstance(v, str)), "")
        return f"remember  “{value}”", [], None
    return f"{name}  {json.dumps(args)[:80]}", [], None


def _entry_surface(ev: dict, width: int, u: float) -> pygame.Surface:
    """One feed event as a block of the panel."""
    body = font("sans", int(17 * u))
    italic = font("sans", int(17 * u), italic=True)
    mono = font("mono", int(15 * u))
    small = font("sans", int(14 * u))
    kind = ev.get("type")
    items: list = []          # surfaces or ("gap", px) or ("curves", list) or ("swatch", rgb)
    indent = int(12 * u)

    def add_text(f, s, color, w=width):
        for line in wrap(f, s, w):
            items.append(text(f, line, color))

    if kind == "wake":
        items.append(("gap", int(14 * u)))
        items.append(("rule", None))
        heard = None
        msg = ev.get("message")
        try:
            data = json.loads(msg) if isinstance(msg, str) else msg
            heard = data.get("heard") if isinstance(data, dict) else None
        except (ValueError, TypeError):
            pass
        reasons = ", ".join(ev.get("reasons") or [])
        add_text(small, f"TURN {ev.get('turn', '?')}   ·   woke at {clock(ev.get('t', 0))}"
                 + (f"   ·   {reasons}" if reasons else ""), AWAKE)
        if heard:
            add_text(body, "heard: " + "  /  ".join(f"“{h}”" for h in heard), VOICE)
    elif kind == "thought":
        f = italic if ev.get("kind") == "thinking" else body
        color = _mix(THOUGHT, (0, 0, 0), 0.22) if ev.get("kind") == "thinking" else THOUGHT
        items.append(("gap", int(4 * u)))
        add_text(f, (ev.get("text") or "").strip(), color)
    elif kind == "call":
        res = ev.get("result") or {}
        line, curves, swatch = _call_line(ev)
        failed = isinstance(res, dict) and res.get("ok") is False
        items.append(("gap", int(3 * u)))
        sw = int(12 * u) if swatch else 0
        lines = wrap(mono, line, width - indent - (sw + 8 if sw else 0))
        for i, s in enumerate(lines):
            items.append(("indent", text(mono, s, WARN if failed else TEXT), swatch if i == 0 else None))
        if failed:
            for s in wrap(mono, f"refused: {res.get('error', '')}", width - indent):
                items.append(("indent", text(mono, s, WARN), None))
        if curves and not failed:
            items.append(("curves", curves))
    elif kind == "voice":
        items.append(("gap", int(6 * u)))
        add_text(body, f"the person says “{ev.get('text', '')}”", VOICE)
    elif kind == "api_error":
        items.append(("gap", int(4 * u)))
        add_text(mono, f"API error, attempt {ev.get('attempt', '?')}: {ev.get('error', '')}", WARN)
    elif kind == "turn_end":
        n = ev.get("tool_calls", 0)
        note = f"asleep after {n} call{'s' if n != 1 else ''}"
        if ev.get("capped"):
            note += ", stopped at the cap"
        if ev.get("skipped"):
            note += ", turn skipped"
        items.append(("gap", int(5 * u)))
        add_text(small, note, ASLEEP)
    elif kind == "close":
        items.append(("gap", int(14 * u)))
        add_text(small, f"SESSION ENDED   ·   {ev.get('reason', '')}   ·   "
                        f"{ev.get('turns', '?')} turns, {ev.get('input_tokens', 0)} in / "
                        f"{ev.get('output_tokens', 0)} out tokens", GONE)

    curve_h = int(22 * u)
    h = 0
    for it in items:
        if isinstance(it, pygame.Surface):
            h += it.get_height()
        elif it[0] == "gap":
            h += it[1]
        elif it[0] == "rule":
            h += int(8 * u)
        elif it[0] == "indent":
            h += it[1].get_height()
        elif it[0] == "curves":
            h += curve_h + int(4 * u)
    surf = pygame.Surface((width, max(1, h)), pygame.SRCALPHA)
    y = 0
    for it in items:
        if isinstance(it, pygame.Surface):
            surf.blit(it, (0, y))
            y += it.get_height()
        elif it[0] == "gap":
            y += it[1]
        elif it[0] == "rule":
            pygame.draw.line(surf, (34, 34, 42), (0, y + 2), (width, y + 2))
            y += int(8 * u)
        elif it[0] == "indent":
            s, sw = it[1], it[2]
            x = indent
            if sw:
                box = pygame.Rect(x, y + (s.get_height() - int(12 * u)) // 2, int(12 * u), int(12 * u))
                pygame.draw.rect(surf, sw, box, border_radius=2)
                pygame.draw.rect(surf, (70, 70, 80), box, width=1, border_radius=2)
                x += box.width + 8
            surf.blit(s, (x, y))
            y += s.get_height()
        elif it[0] == "curves":
            x = indent
            cw = int(70 * u)
            for pts in it[1]:
                frame = pygame.Rect(x, y + int(2 * u), cw, curve_h)
                pygame.draw.rect(surf, (22, 22, 28), frame, border_radius=3)
                if len(pts) >= 2 and pts[-1][0] > 0:
                    span = pts[-1][0]
                    poly = [(frame.x + 3 + (frame.w - 6) * tt / span,
                             frame.bottom - 3 - (frame.h - 6) * max(0, min(1, hh)))
                            for tt, hh in pts]
                    pygame.draw.lines(surf, (150, 160, 190), False, poly, 1)
                x += cw + int(8 * u)
            y += curve_h + int(4 * u)
    return surf


_panel_cache: dict = {}


def draw_panel(surf, lay: Layout, view: View) -> None:
    rect = lay.panel
    if rect is None:
        return
    u = lay.u
    pygame.draw.rect(surf, PANEL_BG, rect)
    pygame.draw.line(surf, (30, 30, 37), rect.topleft, rect.bottomleft)
    pad = int(22 * u)
    x = rect.x + pad
    width = rect.width - 2 * pad
    y = int(20 * u)
    head = text(font("sans", int(13 * u)), "OBSERVER", TEXT_DIM)
    surf.blit(head, (x, y))
    y += head.get_height() + int(2 * u)
    for line in wrap(font("sans", int(13 * u)),
                     "The mind's private side: what it thinks and what it does. "
                     "The person in the room never sees this. Tab hides it.", width):
        s = text(font("sans", int(13 * u)), line, TEXT_FAINT)
        surf.blit(s, (x, y))
        y += s.get_height()
    y += int(10 * u)
    pygame.draw.line(surf, (30, 30, 37), (x, y), (rect.right - pad, y))
    top = y + int(6 * u)

    obs = view.observer
    entries = obs.entries
    bottom = rect.bottom - int(16 * u)
    if not entries:
        msg = {"none": "No mind is connected, so there is nothing to observe.",
               "waiting": "Nothing yet. The mind wakes when someone arrives."}.get(
            obs.status, "Nothing yet.")
        for line in wrap(font("sans", int(15 * u), italic=True), msg, width):
            s = text(font("sans", int(15 * u), italic=True), line, TEXT_FAINT)
            surf.blit(s, (x, top + int(8 * u)))
            top += s.get_height()
        return

    # Newest at the bottom: lay blocks out upwards until the space is used.
    clip = surf.get_clip()
    surf.set_clip(pygame.Rect(rect.x, top, rect.width, bottom - top))
    y = bottom
    for i in range(len(entries) - 1, -1, -1):
        seq, ev = entries[i]
        key = (id(obs), seq, width, round(u, 3))
        block = _panel_cache.get(key)
        if block is None:
            if len(_panel_cache) > 500:
                _panel_cache.clear()
            block = _panel_cache[key] = _entry_surface(ev, width, u)
        y -= block.get_height()
        surf.blit(block, (x, y))
        if y < top:
            break
    surf.set_clip(clip)
    if y < top:   # fade the oldest lines into the header
        fade = pygame.Surface((rect.width - 1, int(30 * u)), pygame.SRCALPHA)
        for i in range(fade.get_height()):
            a = int(255 * (1 - i / fade.get_height()))
            pygame.draw.line(fade, (*PANEL_BG, a), (0, i), (fade.get_width(), i))
        surf.blit(fade, (rect.x + 1, top))


# --- the whole frame -----------------------------------------------------
def draw(surf: pygame.Surface, snap: Snapshot | None, view: View) -> Layout:
    """Draw one frame. Returns the layout, so input can map pixels to pins."""
    rows = snap.rows if snap else 8
    cols = snap.cols if snap else 8
    lay = layout(surf.get_size(), view.panel and not view.clean, rows, cols)
    surf.fill(ROOM_EDGE)
    surf.blit(_room(lay.room.size), lay.room.topleft)
    if snap is not None:
        draw_body(surf, snap, lay)

    # The person. Live: the mouse itself. Replay: the recorded visitor as a ghost.
    if view.mode == "replay":
        if snap is not None and snap.person is not None:
            draw_person(surf, lay, lay.to_pixels(snap.person), snap.pressed is not None, ghost=True)
    elif view.cursor is not None:
        draw_person(surf, lay, view.cursor, view.pressing)

    if view.clean:
        if is_wiring_test(view):   # never let a recording of a wiring test pass for an AI
            draw_banners(surf, lay, snap, View(mode="dryrun"))
        return lay

    draw_intro(surf, lay, view)
    draw_banners(surf, lay, snap, view)
    if view.mode != "replay":
        draw_typing(surf, lay, view)
    draw_status(surf, lay, snap, view)
    draw_panel(surf, lay, view)
    if view.help:
        draw_help(surf, lay, view)
    return lay
