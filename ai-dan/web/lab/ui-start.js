// The start screen: the four ways into the room. It only collects what the
// visitor chose and hands it to app.js. The mind always runs through this
// host (POST /api/mind), which holds the Anthropic key: the page never asks
// for one. At most it asks for the host's access code.

import { formatG } from "./render-base.js";

/** localStorage, or null when this browser will not keep it for the page. */
export function safeStorage() {
  try {
    const store = window.localStorage;
    const probe = "ai-dan.probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

const describe = (err) => (err instanceof Error ? err.message : String(err));

/** What GET /api/mind says the host offers: "open" (a mind, no code needed),
 * "code" (a mind behind an access code) or "none" (no mind, or no answer). */
export function hostMind(answer) {
  if (answer?.available !== true) return "none";
  return answer.code === true ? "code" : "open";
}

const NO_MIND = "No mind is connected on this host, so a live session cannot start here.";
const STILL_WORKS = "The first waking, the wiring test and session logs still work.";
const money = (usd) => `$${Math.max(0, Number(usd) || 0).toFixed(2)}`;

/** The lines the start card shows about the host's mind: why there is none
 * (the host's own reason when it gives one), or what it may still spend. */
export function hostNote(answer) {
  if (hostMind(answer) === "none") {
    const reason = typeof answer?.reason === "string" && answer.reason.trim() ? answer.reason.trim() : NO_MIND;
    return { noMind: `${reason} ${STILL_WORKS}`, budget: null };
  }
  if (typeof answer.limit_usd !== "number") return { noMind: null, budget: null };
  const limit = answer.limit_usd;
  const left = typeof answer.spent_usd === "number" ? `; ${money(limit - answer.spent_usd)} is left` : "";
  return { noMind: null, budget: `This host spends at most ${money(limit)} on the mind${left}.` };
}

/** A secret's value, taken out of its field: the page keeps it only in the
 * session it starts, never in the form, the DOM or storage. */
export function takeValue(input) {
  const value = input.value.trim();
  input.value = "";
  return value;
}

export class StartScreen {
  /**
   * handlers: onWatch(), onWake({accessCode, memory}), onDryrun(),
   * onFile(file); each may return a promise. load(name) imports a lab module.
   */
  constructor(handlers, load) {
    this.handlers = handlers;
    this.load = load;
    const $ = (id) => document.getElementById(id);
    this.el = $("start");
    this.errorEl = $("start-error");
    this.behindEl = $("behind");
    this.form = $("wake-form");
    this.wakeButton = $("wake-go");
    this.codeRow = $("code-row");
    this.codeInput = $("access-code");
    this.wakeNote = $("wake-note");
    this.noMind = $("no-mind");
    this.budget = $("budget");
    this.memory = $("memory");
    this.later = $("later-days");
    this.noteState = $("note-state");
    this.forget = $("forget-note");
    this.fileInput = $("log-file");
    this.busy = false;
    this.host = "checking";       // what GET /api/mind said: see hostMind
    this.hostCheck = null;

    $("watch").addEventListener("click", () => this._run(() => this.handlers.onWatch()));
    $("dryrun").addEventListener("click", () => this._run(() => this.handlers.onDryrun()));
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._wake();
    });
    this.later.addEventListener("toggle", () => this._noteState());
    this.forget.addEventListener("click", () => this._forgetNote());

    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) this._run(() => this.handlers.onFile(file), file.name);
    });
    $("log-file-label").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.fileInput.click();
      }
    });
    this._dropping();
    this._configLine();
    this._checkHost();
  }

  get visible() {
    return !this.el.hidden;
  }

  /** Take a choice from a link: #watch opens the first waking, #wiring-test the wiring test. */
  follow(hash) {
    const route = { "#watch": this.handlers.onWatch, "#wiring-test": this.handlers.onDryrun }[hash];
    if (route) this._run(route);
  }

  show() {
    this.el.hidden = false;
    this.codeInput.value = "";
    this.setError(null);
    this._checkHost();          // the host may have changed since: a local server started, a code set
    document.getElementById("watch").focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
    this.setBehind(false);
  }

  setError(message) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message || "";
  }

  /** Say that the body behind the card is a replay, once it is one. */
  setBehind(on) {
    this.behindEl.hidden = !on;
  }

  // Run a choice; while it starts, the others wait.
  async _run(action, what = "") {
    if (this.busy) return;
    this.busy = true;
    this.setError(null);
    try {
      await action();
    } catch (err) {
      console.error(err);
      this.setError((what ? `${what}: ` : "") + describe(err));
    } finally {
      this.busy = false;
    }
  }

  async _wake() {
    const accessCode = takeValue(this.codeInput);   // out of the field before anything else happens
    const memory = this.memory.checked;
    await this.hostCheck;
    if (this.host === "none") return this.setError("No mind is connected on this host.");
    if (this.host === "code") {
      if (!accessCode) {
        this.codeInput.focus();
        return this.setError("Type the access code first.");
      }
      return this._run(() => this.handlers.onWake({ accessCode, memory }));
    }
    return this._run(() => this.handlers.onWake({ memory }));
  }

  // The model and the limits, from the same Config the session will use.
  async _configLine() {
    try {
      const { Config } = await this.load("config");
      const config = new Config();
      document.getElementById("model-name").textContent = config.MODEL;
      document.getElementById("limits").textContent =
        `${config.MAX_TURNS} turns or ${formatG(config.MAX_SESSION_MIN)} minutes`;
    } catch (err) {
      console.error(err);   // app.js reports module failures when a session needs them
    }
  }

  // Ask the host whether it lends a mind, and shape "Wake a mind" to match.
  _checkHost() {
    this.hostCheck = (async () => {
      let answer = null;
      try {
        const response = await fetch("/api/mind", { headers: { accept: "application/json" }, cache: "no-store" });
        answer = response.ok ? await response.json() : null;
      } catch {
        answer = null;
      }
      this._showHost(hostMind(answer), hostNote(answer));
    })();
    return this.hostCheck;
  }

  _showHost(host, note) {
    this.host = host;
    const none = host === "none";
    this.codeRow.hidden = host !== "code";
    this.noMind.hidden = !none;
    if (note.noMind) this.noMind.textContent = note.noMind;
    this.budget.hidden = !note.budget;
    this.budget.textContent = note.budget ?? "";
    this.wakeNote.hidden = none;
    this.later.hidden = none;
    this.wakeButton.disabled = none;
  }

  async _noteState() {
    if (!this.later.open) return;
    const store = safeStorage();
    this.forget.hidden = true;
    if (!store) {
      this.noteState.textContent = "This browser keeps no local storage for this page, so a note would last only until the tab closes.";
      return;
    }
    try {
      const { loadNote } = await this.load("mind");
      const note = loadNote(store);
      if (note) {
        this.noteState.textContent = `A note from an earlier session is waiting: ${[...note].length} characters.`;
        this.forget.hidden = false;
      } else {
        this.noteState.textContent = "No note yet. The first session in this mode starts without one.";
      }
    } catch (err) {
      this.noteState.textContent = `The note could not be read: ${describe(err)}`;
    }
  }

  async _forgetNote() {
    try {
      const { NOTE_KEY } = await this.load("mind");
      safeStorage()?.removeItem(NOTE_KEY);
    } catch (err) {
      this.setError(`The note could not be removed: ${describe(err)}`);
    }
    this._noteState();
  }

  // Drop a log anywhere on the start screen. During a session a drop does
  // nothing at all: the browser must not navigate away from a live mind.
  _dropping() {
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this.visible ? "copy" : "none";
      this.el.classList.toggle("dragging", this.visible);
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) this.el.classList.remove("dragging");
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.el.classList.remove("dragging");
      const file = e.dataTransfer.files[0];
      if (this.visible && file) this._run(() => this.handlers.onFile(file), file.name);
    });
  }
}
