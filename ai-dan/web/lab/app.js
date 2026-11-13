// The page: the start screen, the sessions, input and the frame loop.
// A port of lab/app.py and the session lifecycle of lab/__main__.py.
//
// The canvas draws the room (render.js). The few things that must be real
// controls are HTML on top of it: the typing line, so phone keyboards and
// input methods work, and small buttons for what the desktop does with keys.
// The lab's own modules are loaded on demand, so a broken one shows up as an
// error on the page instead of a blank screen.

import { font } from "./render-base.js";
import { draw, makeView, restingSnapshot, statusY, typingY } from "./render.js";
import { keyAction } from "./ui-loop.js";
import { Session, notALog } from "./ui-session.js";
import { StartScreen, safeStorage } from "./ui-start.js";

const TITLE = "A body to wake up in";
const FIRST_WAKE = "sessions/first-wake.jsonl";
const SPEEDS = [1, 2, 4, 0.5];
const PREVIEW_HOLD_S = 3;          // the replay behind the start card rests this long before it starts again
const PANEL_OPEN_WIDTH = 900;      // a replay opens with the observer panel on windows at least this wide,
                                   // and the start card stands in the panel's place, beside the body

const $ = (id) => document.getElementById(id);
const canvas = $("room");
const ctx = canvas.getContext("2d", { alpha: false });
const voice = $("voice");
const voiceInput = $("voice-input");
const voiceHint = $("voice-hint");
const controls = $("controls");
const showText = $("show-text");
const buttons = Object.fromEntries([...controls.querySelectorAll("button")].map((b) => [b.dataset.act, b]));

let lastTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;   // the visitor's last pointer was a finger
const startView = makeView({ mode: "replay", clean: true, intro: 0 });
const RESTING = restingSnapshot();
let session = null;                // what the room shows: the replay behind the start card, or a session
let size = { width: 0, height: 0, dpr: 1 };
let panelDrag = null;              // a finger scrolling the observer panel: its last y

// --- errors: on the page, not only in the console ------------------------
const errorsBox = $("errors");
const shownErrors = new Map();

function report(err, context = "") {
  console.error(context, err);
  const text = (context ? `${context}: ` : "") + (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const seen = shownErrors.get(text);
  if (seen) {
    seen.count += 1;
    seen.counter.textContent = ` (${seen.count} times)`;
    return;
  }
  const item = document.createElement("div");
  item.className = "error-item";
  const counter = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => {
    item.remove();
    shownErrors.delete(text);
  });
  item.append(text, counter, close);
  errorsBox.append(item);
  shownErrors.set(text, { count: 1, counter });
}

window.addEventListener("error", (e) => report(e.error ?? e.message, "Page error"));
window.addEventListener("unhandledrejection", (e) => report(e.reason, "Page error"));

// --- the lab's modules, loaded when first needed -------------------------
const modules = new Map();
function load(name) {
  if (!modules.has(name)) modules.set(name, import(`./${name}.js`));
  return modules.get(name);
}

let firstWake = null;
function firstWakeEvents() {
  firstWake ??= Promise.all([
    fetch(FIRST_WAKE).then((r) => {
      if (!r.ok) throw new Error(`${FIRST_WAKE}: HTTP ${r.status}`);
      return r.text();
    }),
    load("log"),
  ]).then(([text, { parseLog }]) => parseLog(text));
  firstWake.catch(() => { firstWake = null; });   // a later click tries again
  return firstWake;
}

// --- sessions --------------------------------------------------------------
const start = new StartScreen({
  onWatch: async () => openReplay(await firstWakeEvents(), "first-wake.jsonl"),
  onWake: (auth) => openLive(auth),
  onDryrun: () => openLive({ dryrun: true }),
  onFile: (file) => openFile(file),
}, load);

const touchNow = () => lastTouch;

function enter(s) {
  session = s;
  if (start.el.contains(document.activeElement)) document.activeElement.blur();   // the card's buttons are gone
  start.hide();
  document.title = s.replay ? `${TITLE}  (replay: ${s.name})`
    : s.kind === "dryrun" ? `${TITLE}  (wiring test, not an AI)` : TITLE;
  voiceInput.value = "";
  updateHint();
  refocus();
}

async function openReplay(events, name, { speed = 1, panel = null } = {}) {
  const { ReplayWorld } = await load("world");
  let world;
  try {
    world = new ReplayWorld(events);
  } catch (err) {
    throw notALog(err);
  }
  const view = makeView({ mode: "replay", intro: 0, replayName: name, speed, touch: touchNow(),
    panel: panel ?? window.innerWidth >= PANEL_OPEN_WIDTH });
  enter(new Session({ kind: "replay", world, view, events, name }));
}

async function openFile(file) {
  const [text, { parseLog }] = await Promise.all([file.text(), load("log")]);
  let events;
  try {
    events = parseLog(text);   // strict, like Python's read_log: one bad line and it is not a log
  } catch (err) {
    throw notALog(err);
  }
  await openReplay(events, file.name);
}

/** A live session, or the wiring test: Config, SessionLog, World, the model,
 * the harness, as lab/__main__.py builds them. */
async function openLive({ dryrun = false, apiKey = null, accessCode = null, memory = false }) {
  const [{ Config }, { SessionLog }, { World }] = await Promise.all([load("config"), load("log"), load("world")]);
  const config = new Config(memory ? { MEMORY_ENABLED: true } : {});
  const log = new SessionLog();
  const world = new World(config, log);
  let harness = null;
  let detail = null;
  try {
    const [{ AnthropicModel, ScriptedModel }, { Harness }] = await Promise.all([load("model"), load("harness")]);
    const model = dryrun ? new ScriptedModel(config)
      : new AnthropicModel(config, apiKey ? { apiKey } : { accessCode });
    harness = new Harness(world, model, config, { noteStore: memory ? safeStorage() : null });
    harness.start();
  } catch (err) {   // the mind's modules are young; keep the body usable
    report(err, "The mind could not be started");
    harness = null;
    detail = `the mind's code could not be started (${err?.name}: ${err?.message}).`;
  }
  if (harness === null && log.feed.length === 0) {
    log.writeHeader(config, { t: world.t, prompt_version: config.PROMPT_VERSION, prompt: null,
      model: null, tools: [], memory_enabled: config.MEMORY_ENABLED, mind: "none" });
  }
  const kind = dryrun ? "dryrun" : "live";
  const view = makeView({ mode: harness ? kind : "nokey", nokeyDetail: detail, logName: log.fileName(), touch: touchNow() });
  enter(new Session({ kind, world, log, harness, view }));
}

// The replay behind the start card: the first waking, again and again.
function preview(events, ReplayWorld) {
  const s = new Session({ kind: "replay", world: new ReplayWorld(events), events, name: "first-wake.jsonl",
    view: makeView({ mode: "replay", clean: true, intro: 0 }) });
  s.preview = true;
  return s;
}

async function startPreview() {
  try {
    const [events, { ReplayWorld }] = await Promise.all([firstWakeEvents(), load("world")]);
    if (!start.visible || session) return;
    session = preview(events, ReplayWorld);
    start.setBehind(true);
  } catch (err) {
    report(err, "The first waking could not be loaded");
  }
}

function showStart() {
  session = null;
  document.title = TITLE;
  start.show();
  startPreview();
}

async function endSession() {
  const s = session;
  if (!s || s.replay || s.halted) return;
  if (s.running && s.harness && !window.confirm("End this session? The mind stops. Its log stays here to download.")) return;
  try {
    await s.shutdown();
  } catch (err) {
    report(err, "The session did not close cleanly");
  }
}

async function backToStart() {
  const s = session;
  if (s?.kind === "live" && s.unsaved && !window.confirm(s.savedLength
    ? "Go back to the start? This session's log has grown since you downloaded it, and the rest will be lost."
    : "Go back to the start? This session's log has not been downloaded and will be lost.")) return;
  if (s && !s.halted) {
    try {
      await s.shutdown();
    } catch (err) {
      report(err, "The session did not close cleanly");
    }
  }
  showStart();
}

async function download(s) {
  if (!s?.log) return;
  // Once the mind has ended, the file is made whole first: the room stops,
  // the world writes its last state and the log closes, as when the desktop
  // window closes. Before that, the download is the log so far.
  if (s.mindEnded && !s.halted) {
    try {
      await s.shutdown();
    } catch (err) {
      report(err, "The session did not close cleanly");
    }
  }
  const { text, name } = s.logFile();
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function toggleFullscreen() {
  const done = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
  done?.catch((err) => report(err, "Fullscreen"));
}

function act(name) {
  const s = session;
  if (!s || s.preview) return;
  const v = s.view;
  switch (name) {
    case "panel": v.panel = !v.panel; break;
    case "help": v.help = !v.help; break;
    case "clean": v.clean = !v.clean; break;
    case "fullscreen": toggleFullscreen(); break;
    case "pause": v.paused = !v.paused; break;
    case "speed": v.speed = SPEEDS[(SPEEDS.indexOf(v.speed) + 1) % SPEEDS.length]; break;
    case "again": openReplay(s.events, s.name, { speed: v.speed, panel: v.panel }).catch((err) => report(err, "Replay")); break;
    case "download": download(s).catch((err) => report(err, "Download")); break;
    case "end": endSession(); break;
    case "back": backToStart(); break;
    default: break;
  }
}

// --- input -------------------------------------------------------------------
const inRoom = () => Boolean(session) && !session.preview && !start.visible;
const inside = (r, x, y) => r && x >= r.x && x < r.right && y >= r.y && y < r.bottom;

function noteTouch(e) {
  lastTouch = e.pointerType === "touch";
  if (session) session.view.touch = lastTouch;
}

// Keys go to the room unless they are the person's voice.
function refocus() {
  if (inRoom() && !session.replay && !touchNow() && !voice.hidden) voiceInput.focus({ preventScroll: true });
}

canvas.addEventListener("pointerdown", (e) => {
  if (!inRoom() || !e.isPrimary) return;
  noteTouch(e);
  if (e.pointerType === "touch" && inside(session.layout.panel, e.clientX, e.clientY)) {
    panelDrag = e.clientY;     // a finger on the panel reads it; it is not in the room
    return;
  }
  if (e.pointerType !== "touch" && e.button !== 0) {
    session.pointer.move(e.clientX, e.clientY, e.pointerType);
    return;
  }
  session.pointer.down(e.clientX, e.clientY, e.pointerType);
});
canvas.addEventListener("mousedown", (e) => e.preventDefault());   // clicking the room keeps the typing line focused

window.addEventListener("pointermove", (e) => {
  if (!inRoom() || !e.isPrimary) return;
  if (e.pointerType === "touch" && panelDrag !== null) {
    scrollPanel(e.clientY - panelDrag);
    panelDrag = e.clientY;
    return;
  }
  noteTouch(e);
  session.pointer.move(e.clientX, e.clientY, e.pointerType);
});

function release(e) {
  if (!e.isPrimary) return;
  if (e.pointerType === "touch") panelDrag = null;
  if (e.pointerType === "touch" || e.button === 0) session?.pointer.up(e.pointerType);
}
window.addEventListener("pointerup", release);
window.addEventListener("pointercancel", (e) => {
  panelDrag = null;
  if (e.isPrimary) session?.pointer.up(e.pointerType);
});
// The pointer left the window: the person left the room.
document.documentElement.addEventListener("mouseleave", () => session?.pointer.leave());
document.addEventListener("mouseout", (e) => {
  if (e.relatedTarget === null) session?.pointer.leave();
});

canvas.addEventListener("wheel", (e) => {
  if (!session || !inside(session.layout.panel, e.clientX, e.clientY)) return;
  e.preventDefault();
  scrollPanel(-e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1));
}, { passive: false });

function scrollPanel(dy) {
  const v = session.view;
  const max = session.layout.panelInfo?.maxScroll ?? 0;
  v.panelScroll = Math.max(0, Math.min(max, v.panelScroll + dy));
}

// The session's own buttons, and the notes' close buttons: keys that move or
// press them are theirs.
const isControl = (el) => el instanceof HTMLButtonElement
  && (controls.contains(el) || el === showText || errorsBox.contains(el));

window.addEventListener("keydown", (e) => {
  if (!inRoom()) return;
  const focus = document.activeElement;
  const action = keyAction({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
    onControl: isControl(focus), replay: session.replay, typing: focus === voiceInput,
    helpOpen: session.view.help });
  if (action === null) return;
  if (action === "type") {
    if (!voice.hidden) voiceInput.focus({ preventScroll: true });   // the key itself lands in the line
    return;
  }
  e.preventDefault();
  if (action === "close-help") session.view.help = false;
  else act(action);
}, true);

voice.addEventListener("submit", (e) => {
  e.preventDefault();
  session?.say(voiceInput.value);
  voiceInput.value = "";
  updateHint();
});
voiceInput.addEventListener("input", updateHint);

function updateHint() {
  const empty = voiceInput.value === "";
  voice.classList.toggle("empty", empty);
  voiceHint.hidden = voiceInput.value.trim() === "";
  voiceHint.textContent = touchNow() ? "Send to say it" : "Enter to say it";
}

controls.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  act(button.dataset.act);
  if (e.detail > 0) {        // a pointer click: the keys go back to the room; a key press keeps its place
    button.blur();
    refocus();
  }
});
showText.addEventListener("click", () => {
  act("clean");
  showText.blur();
  refocus();
});

// A hidden tab: the person has left. The body and the mind go on, woken by a
// timer (browsers stop animation frames in the background).
let hiddenTimer = null;
document.addEventListener("visibilitychange", () => {
  clearInterval(hiddenTimer);
  hiddenTimer = null;
  if (!document.hidden || !session) return;
  session.pointer.leave();
  if (session.replay) return;
  const pump = () => {
    if (!session || session.replay) return;
    try {
      session.advance(performance.now() / 1000, { hidden: true });
    } catch (err) {
      fail(session, err);
    }
  };
  pump();
  hiddenTimer = setInterval(pump, 250);
});

window.addEventListener("beforeunload", (e) => {
  if (session?.kind === "live" && (session.running || session.unsaved)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  if (session && !session.preview) session.shutdown().catch(() => {});
});

// --- the frame -----------------------------------------------------------------
function fitCanvas() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (width !== size.width || height !== size.height || dpr !== size.dpr) {
    size = { width, height, dpr };
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
  }
}

function fail(s, err) {
  report(err, s.replay ? "The replay stopped" : "The body stopped");
  if (!s.halted) s.shutdown().catch((e) => report(e, "The session did not close cleanly"));
}

// Older observer entries stay put while new ones arrive below.
function keepPanelScroll(s, lay) {
  const info = lay.panelInfo;
  if (!info) {
    s.panelTotal = null;
    return;
  }
  const v = s.view;
  if (v.panelScroll > 0 && s.panelTotal != null && info.total > s.panelTotal) v.panelScroll += info.total - s.panelTotal;
  v.panelScroll = Math.max(0, Math.min(info.maxScroll, v.panelScroll));
  s.panelTotal = info.total;
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  try {
    fitCanvas();
    const s = session;
    if (s) {
      try {
        s.advance(now);
      } catch (err) {
        fail(s, err);
      }
      if (s.preview && s.world.done) {
        s.doneAt ??= now;
        if (now - s.doneAt >= PREVIEW_HOLD_S && session === s) session = preview(s.events, s.world.constructor);
      }
    }
    const view = s ? s.view : startView;
    if (start.visible) view.aside = size.width >= PANEL_OPEN_WIDTH;
    const lay = draw(ctx, s ? s.world.snapshot() : RESTING, view, size);
    if (s) {
      s.layout = lay;
      keepPanelScroll(s, lay);
    }
    syncPage(lay);
  } catch (err) {
    report(err, "The room could not be drawn");
  }
}

// --- the HTML on top of the canvas -------------------------------------------
// The buttons sit at the right of the status line, where the desktop writes
// its key hints, unless the two would touch; then they get a row of their own.
function stackControls(s, lay) {
  const shown = [...controls.children].filter((b) => !b.hidden);
  const gap = 6;
  const natural = shown.reduce((sum, b) => sum + b.offsetWidth, 0) + gap * Math.max(0, shown.length - 1);
  const free = lay.room.right - Math.trunc(22 * lay.u) - natural - (lay.statusRight ?? 0);
  s.stacked = s.stacked ? free < 64 : free < 24;    // a little hysteresis: the status line changes length
  return s.stacked;
}

const styleCache = new WeakMap();
function place(el, styles) {
  const last = styleCache.get(el) ?? {};
  for (const [key, value] of Object.entries(styles)) {
    if (last[key] !== value) {
      el.style.setProperty(key, value);
      last[key] = value;
    }
  }
  styleCache.set(el, last);
}
function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}
function setPressed(el, on) {
  const value = String(on);
  if (el.getAttribute("aria-pressed") !== value) el.setAttribute("aria-pressed", value);
}
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function syncPage(lay) {
  const aside = start.visible && lay.panel !== null;
  start.el.classList.toggle("aside", aside);
  if (aside) place(start.el, { "--room-w": `${lay.room.w}px` });
  const s = inRoom() ? session : null;
  const v = s?.view;
  setHidden(controls, !s || v.clean);
  setHidden(showText, !s || !v.clean);
  const voiceOn = Boolean(s) && !s.replay && !s.halted && v.observer.status !== "ended";
  const appearing = voiceOn && voice.hidden;
  setHidden(voice, !voiceOn);
  if (appearing) refocus();
  document.body.classList.toggle("hide-cursor", Boolean(s) && !s.replay && !s.halted && !v.touch);
  document.body.classList.toggle("touch", touchNow());
  if (!s) return;

  const u = lay.u;
  setHidden(buttons.pause, !s.replay);
  setHidden(buttons.speed, !s.replay);
  setHidden(buttons.again, !(s.replay && s.world.done));
  setHidden(buttons.download, s.replay);
  const over = s.halted || s.mindEnded;     // a mind that ended by itself needs no "End session"
  setHidden(buttons.end, s.replay || over);
  setHidden(buttons.back, !(s.replay || over));
  setHidden(buttons.fullscreen, !document.fullscreenEnabled);
  setHidden(buttons.clean, lay.compact);
  setPressed(buttons.panel, v.panel);
  setPressed(buttons.help, v.help);
  setPressed(buttons.pause, v.paused);
  setPressed(buttons.fullscreen, Boolean(document.fullscreenElement));
  setText(buttons.pause, v.paused ? "Play" : "Pause");
  setText(buttons.speed, `Speed ${v.speed}×`);

  place(controls, { "--ui": `${Math.max(12, Math.trunc(13 * u))}px` });
  if (stackControls(s, lay)) {
    // Narrow: the buttons get their own row under the status line.
    place(controls, { left: `${lay.room.x + 12}px`, right: `${size.width - lay.room.right + 12}px`,
      top: "auto", bottom: `${size.height - lay.room.bottom + 10}px`, "justify-content": "center" });
    v.statusLift = controls.offsetHeight + 10;
    v.keysLeft = null;
  } else {
    // Wide: where the desktop writes its key hints, at the right of the status line.
    const middle = statusY(lay, v) + font("sans", 14 * u).lineH / 2;
    place(controls, { left: "auto", right: `${size.width - lay.room.right + Math.trunc(22 * u)}px`,
      top: `${Math.round(middle - controls.offsetHeight / 2)}px`, bottom: "auto", "justify-content": "flex-end" });
    v.statusLift = 0;
    v.keysLeft = lay.room.right - Math.trunc(22 * u) - controls.offsetWidth;
  }

  if (voiceOn) {
    const width = Math.min(lay.room.w - 32, Math.trunc(560 * u));
    place(voice, { left: `${Math.round(lay.room.cx - width / 2)}px`, top: `${typingY(lay) - 4}px`, width: `${width}px`,
      "--voice": `${font("sans", 18 * u).size}px`, "--voice-hint": `${font("sans", 12 * u).size}px`,
      "--voice-placeholder": `${font("sans", 13 * u).size}px` });
    const placeholder = v.intro < 0.05 ? (v.touch ? "tap here to speak" : "type to speak") : "";
    if (voiceInput.placeholder !== placeholder) voiceInput.placeholder = placeholder;
    voice.classList.toggle("clean", v.clean);
  }
}

// --- boot ------------------------------------------------------------------------
$("boot-note").remove();
showStart();
// A link into the room (#watch, #wiring-test) is followed from the start
// screen, then cleared, so the same link works again after Back to start.
function followHash() {
  const hash = window.location.hash;
  if (!hash) return;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (start.visible) start.follow(hash);
}
followHash();
window.addEventListener("hashchange", followHash);
requestAnimationFrame(frame);
