// Session log: one JSON object per line, kept in memory (port of lab/log.py).
//
// Every event goes through `SessionLog.write`. Each line is written exactly as
// Python's json.dumps would write it, so a log downloaded from the browser is
// read by the Python lab like any other. Each event also lands in a `Feed`,
// which is what the page reads to show the observer panel, live or in replay.

import { pyDumps, pyLoads, pyStrip } from "./py.js";

export const LOG_VERSION = 1;

/** Append-only list of events. */
export class Feed {
  constructor() {
    this._events = [];
  }

  append(event) {
    this._events.push(event);
  }

  /** Events from `index` on. Keep `index + result.length` for the next call. */
  since(index) {
    return this._events.slice(index);
  }

  get length() {
    return this._events.length;
  }
}

export class SessionLog {
  /** `now` is the wall clock, used only for the header and the file name. */
  constructor({ feed = null, now = () => new Date() } = {}) {
    this.feed = feed ?? new Feed();
    this._now = now;
    this._createdAt = now();
    this._lines = [];
    this._closed = false;
  }

  write(event) {
    const line = pyDumps(event);
    if (!this._closed) this._lines.push(line);
    // The feed gets the JSON-normalised copy, so live and replay match.
    this.feed.append(pyLoads(line));
  }

  writeHeader(config, extra = {}) {
    this.write({
      type: "header",
      version: LOG_VERSION,
      started_at: isoSeconds(this._now()),
      config: config.toDict(),
      ...extra,
    });
  }

  /** The whole file: one line per event, each ending in "\n". */
  text() {
    return this._lines.map((line) => `${line}\n`).join("");
  }

  /** YYYY-MM-DD_HHMMSS.jsonl, from when the log was created, as in Python. */
  fileName() {
    const d = this._createdAt;
    return `${datePart(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
  }

  close() {
    this._closed = true;
  }
}

/** The events of a JSONL file. */
export function parseLog(text) {
  const events = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {     // Python's universal newlines
    const line = pyStrip(raw);
    if (line) events.push(pyLoads(line));
  }
  return events;
}

const pad = (n) => String(n).padStart(2, "0");
const datePart = (d) => `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Local time, like datetime.now().isoformat(timespec="seconds").
function isoSeconds(d) {
  return `${datePart(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
