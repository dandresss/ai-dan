// The start screen: the four ways into the room. It only collects what the
// visitor chose and hands it to app.js; the key stays in its password field
// and in the model object, and goes nowhere else.

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

/** A secret's value, taken out of its field: the page keeps it only in the
 * session it starts, never in the form, the DOM or storage. */
export function takeValue(input) {
  const value = input.value.trim();
  input.value = "";
  return value;
}

export class StartScreen {
  /**
   * handlers: onWatch(), onWake({apiKey | accessCode, memory}), onDryrun(),
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
    this.openButton = $("wake-open");
    this.keyInput = $("api-key");
    this.codeInput = $("access-code");
    this.keyRow = $("key-row");
    this.codeRow = $("code-row");
    this.authChoice = $("auth-choice");
    this.memory = $("memory");
    this.later = $("later-days");
    this.noteState = $("note-state");
    this.forget = $("forget-note");
    this.fileInput = $("log-file");
    this.busy = false;

    $("watch").addEventListener("click", () => this._run(() => this.handlers.onWatch()));
    $("dryrun").addEventListener("click", () => this._run(() => this.handlers.onDryrun()));
    this.openButton.addEventListener("click", () => this._toggleForm());
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._wake();
    });
    for (const radio of this.authChoice.querySelectorAll("input")) {
      radio.addEventListener("change", () => this._showAuth());
    }
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
    this._accessCheck();
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
    this.keyInput.value = "";
    this.codeInput.value = "";
    this.setError(null);
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

  _toggleForm() {
    const open = this.form.hidden;
    this.form.hidden = !open;
    this.openButton.setAttribute("aria-expanded", String(open));
    if (open) (this._useCode() ? this.codeInput : this.keyInput).focus();
  }

  _useCode() {
    return !this.authChoice.hidden && this.authChoice.querySelector('input[value="code"]').checked;
  }

  _showAuth() {
    const code = this._useCode();
    this.keyRow.hidden = code;
    this.codeRow.hidden = !code;
  }

  _wake() {
    const memory = this.memory.checked;
    const apiKey = takeValue(this.keyInput);
    const accessCode = takeValue(this.codeInput);
    if (this._useCode()) {
      if (!accessCode) return this.setError("Type the access code first.");
      return this._run(() => this.handlers.onWake({ accessCode, memory }));
    }
    if (!apiKey) return this.setError("Paste your Anthropic API key first.");
    return this._run(() => this.handlers.onWake({ apiKey, memory }));
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

  // The access-code mode exists only when the host has turned it on.
  async _accessCheck() {
    try {
      const response = await fetch("/api/mind", { headers: { accept: "application/json" } });
      const data = response.ok ? await response.json() : null;
      this.authChoice.hidden = data?.available !== true;
    } catch {
      this.authChoice.hidden = true;
    }
    this._showAuth();
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
