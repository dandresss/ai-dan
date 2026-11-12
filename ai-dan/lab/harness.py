"""The mind loop: what wakes the agent, the anatomy of a turn, in-session
memory, limits and the mind's half of the log (harness.md).

The thread is a thin shell around `step()`, which makes every decision from
`world.t` and the event queue. Tests drive `step()` directly with a clock they
control; nothing here reads the wall clock except the retry waits.
"""
from __future__ import annotations

import json
import queue
import threading
from pathlib import Path

from .body import WorldClosed
from .config import NOTE_PATH, Config
from .mind import load_note, save_note, system_prompt, text, tool_definitions
from .model import Model, ModelError, ModelResponse

RETRY_WAITS_S = (2.0, 4.0, 8.0)   # harness.md: retried up to three times, growing waits


class Harness:
    def __init__(self, world, model: Model, config: Config, note_path: Path | None = None):
        self.world = world
        self.model = model
        self.config = config
        self.note_path = (note_path or NOTE_PATH) if config.MEMORY_ENABLED else None
        note = load_note(self.note_path)
        # Frozen for the whole session: a note written now is for the next one.
        self.system = system_prompt(config, note)
        self.tools = tool_definitions(config)
        self.body = world.remote_body()
        self.retry_waits = RETRY_WAITS_S
        self.sleep = lambda seconds: self._stop.wait(seconds)

        # The conversation, kept in full; fading is applied when it is sent.
        self.messages: list[dict] = []
        self._sense_turn: dict[str, tuple[int, float | None]] = {}  # tool_use id -> (turn, t)
        self._pending_results: list[dict] = []  # results that travel with the next wake

        # Session state
        self.turn = 0
        self.started_at: float | None = None
        self.left_at: float | None = None     # outside, but still within the grace
        self.departed = False                 # departure registered; no pulse until return
        self.last_turn_end: float | None = None
        self.reasons: list[str] = []
        self.heard: list[str] = []
        self.input_tokens = 0
        self.output_tokens = 0
        self.ended = False

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # --- lifecycle ---------------------------------------------------------
    def start(self, run_thread: bool = True) -> None:
        """Write the header, then start the mind thread. Tests pass
        `run_thread=False` and call `step()` themselves."""
        self.world.log.write_header(
            self.config,
            t=self.world.t,
            prompt_version=self.config.PROMPT_VERSION,
            prompt=self.system,
            model=self.model.name,
            tools=[tool["name"] for tool in self.tools],
            memory_enabled=self.config.MEMORY_ENABLED,
            mind="scripted" if self.model.name == "scripted" else "live",
        )
        if run_thread:
            self._thread = threading.Thread(target=self._loop, name="mind", daemon=True)
            self._thread.start()

    def stop(self, reason: str = "window_closed") -> None:
        """Close the world before calling this, so a body call the mind is
        waiting on is released rather than left waiting for a tick."""
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            # Long enough for an interrupted turn to log its end. A model
            # request in flight cannot be interrupted; whatever it brings back
            # after the close is discarded.
            thread.join(timeout=1.0)
        self._end(reason)

    def _loop(self) -> None:
        while not self.ended and not self._stop.is_set():
            if not self.step():
                self._stop.wait(0.02)

    # --- deciding when to wake ---------------------------------------------
    def step(self) -> bool:
        """Take in what happened, then run a turn if something should wake the
        mind. Returns True if a turn ran."""
        if self.ended:
            return False
        self._drain_events()
        if self.started_at is None:
            return False
        cfg = self.config
        now = self.world.t
        if now >= self.started_at + cfg.MAX_SESSION_MIN * 60:
            self._end("max_minutes")
            return False
        if self.left_at is not None and now - self.left_at >= cfg.ABSENCE_GRACE_S:
            self.left_at = None
            self.departed = True
            self._add_reason("departure")
        present = not self.departed and self.left_at is None
        if (not self.reasons and present and self.last_turn_end is not None
                and now - self.last_turn_end >= cfg.PULSE_S):
            self._add_reason("pulse")
        if not self.reasons:
            return False

        reasons, heard = self.reasons, self.heard
        self.reasons, self.heard = [], []
        self._run_turn(reasons, heard)
        if not self.ended and self.turn >= cfg.MAX_TURNS:
            self._end("max_turns")
        return True

    def _drain_events(self) -> None:
        while True:
            try:
                event = self.world.events.get_nowait()
            except queue.Empty:
                return
            kind, t = event[0], event[1]
            if kind == "enter":
                if self.started_at is None:
                    self.started_at = t
                    self._add_reason("arrival")
                elif self.departed:
                    self.departed = False
                    self._add_reason("arrival")
                elif self.left_at is not None and t - self.left_at >= self.config.ABSENCE_GRACE_S:
                    # Gone for longer than the grace and back again while a
                    # turn was running: judged by when it happened, not by now.
                    self._add_reason("departure")
                    self._add_reason("arrival")
                self.left_at = None  # back within the grace: not an event
            elif kind == "leave":
                if not self.departed:
                    self.left_at = t
            elif kind == "voice":
                self.heard.append(event[2])
                self._add_reason("voice")

    def _add_reason(self, reason: str) -> None:
        if reason not in self.reasons:
            self.reasons.append(reason)

    # --- one turn ------------------------------------------------------------
    def _run_turn(self, reasons: list[str], heard: list[str]) -> None:
        cfg = self.config
        self.turn += 1
        turn = self.turn
        self.world.turn = turn

        wake = {"t": float(self.world.t)}
        if heard:
            wake["heard"] = list(heard)
        wake_text = json.dumps(wake, ensure_ascii=False)
        blocks = self._pending_results + [{"type": "text", "text": wake_text}]
        self._pending_results = []
        if self.messages and self.messages[-1]["role"] == "user":
            # The last turn ended without an answer from the model. Roles must
            # alternate, so this wake joins the message that is still waiting.
            self.messages[-1] = {"role": "user", "content": self.messages[-1]["content"] + blocks}
        else:
            self.messages.append({"role": "user", "content": blocks})
        first = len(self.messages) - 1
        self._log({"type": "wake", "turn": turn, "reasons": reasons, "message": wake_text})

        calls, capped, skipped, end_after = 0, False, False, None
        deadline = self.started_at + cfg.MAX_SESSION_MIN * 60
        try:
            while not self.ended:
                if self.world.t >= deadline:
                    end_after = "max_minutes"
                    break
                response = self._respond(turn)
                if response is None or self.ended:
                    skipped = response is None
                    break
                self._log({"type": "usage", "turn": turn, "model": response.model,
                           "stop_reason": response.stop_reason,
                           "input_tokens": response.input_tokens,
                           "output_tokens": response.output_tokens})
                self.input_tokens += response.input_tokens
                self.output_tokens += response.output_tokens
                if response.stop_reason == "refusal":
                    skipped = True
                    break

                content = [b for b in response.content if not _empty_text(b)]
                self._log_thoughts(turn, content)
                uses = [b for b in content if b.get("type") == "tool_use"]
                if content:
                    self.messages.append({"role": "assistant", "content": content})
                if not uses:
                    break
                if self.world.t >= deadline:
                    end_after = "max_minutes"   # the session is over: leave the body alone
                    break
                # A response cut off at the output cap may end in a half-written
                # call that still parses. The body must not run a movement the
                # mind did not finish ordering, so none of its calls are run.
                cut_off = response.stop_reason == "max_tokens"

                results = []
                for use in uses:
                    if self.ended:
                        return
                    if calls < cfg.MAX_TOOL_CALLS and not cut_off:
                        result = self._run_tool(turn, use)
                        calls += 1
                    else:
                        result = {"ok": False, "t": self.world.t, "error": text(cfg, "past_cap")}
                        self._log({"type": "call", "turn": turn, "name": use.get("name"),
                                   "args": use.get("input"), "result": result})
                    results.append(_tool_result(use, result))
                if cut_off or calls >= cfg.MAX_TOOL_CALLS:
                    capped = True
                    self._pending_results = results
                    break
                self.messages.append({"role": "user", "content": results})
        except WorldClosed:
            end_after = "window_closed"
        finally:
            self._settle(first)
            self.last_turn_end = self.world.t
            self._log({"type": "turn_end", "turn": turn, "tool_calls": calls,
                       "capped": capped, "skipped": skipped})
        if end_after:
            self._end(end_after)

    def _respond(self, turn: int) -> ModelResponse | None:
        """One model call with the harness's retries. None means give up."""
        messages = self._outgoing(turn)
        attempts = 1 + len(self.retry_waits)
        for attempt in range(1, attempts + 1):
            if self.ended:
                return None
            try:
                return self.model.respond(self.system, self.tools, messages)
            except ModelError as exc:
                error, retryable = str(exc), exc.retryable
            except Exception as exc:  # keep the mind thread alive whatever happens
                error, retryable = f"{type(exc).__name__}: {exc}", False
            self._log({"type": "api_error", "turn": turn, "attempt": attempt, "error": error})
            if not retryable or attempt == attempts:
                return None
            self.sleep(self.retry_waits[attempt - 1])
        return None

    def _run_tool(self, turn: int, use: dict) -> dict:
        name, args = use.get("name"), use.get("input")
        if name == "remember" and self.config.MEMORY_ENABLED:
            error = save_note(self.config, self.note_path, args)
            result = {"ok": True, "t": self.world.t}
            if error:
                result = {"ok": False, "t": self.world.t, "error": error}
            self._log({"type": "call", "turn": turn, "name": name, "args": args, "result": result})
            return result
        # Everything else is the body's to answer, unknown names included.
        result = self.body.call(name, args)
        if name == "sense" and isinstance(result, dict):
            self._sense_turn[use["id"]] = (turn, result.get("t"))
        return result

    # --- memory ----------------------------------------------------------------
    def _outgoing(self, turn: int) -> list[dict]:
        """The history as sent during `turn`: the last MEMORY_FULL_TURNS
        finished turns in full, older `sense` results faded to a marker. The
        result is the same for every call within a turn, so in-turn thinking
        blocks stay valid."""
        oldest_full = turn - self.config.MEMORY_FULL_TURNS
        out = []
        for message in self.messages:
            content = message["content"]
            if message["role"] == "user" and isinstance(content, list):
                content = [self._faded(block, oldest_full) for block in content]
            else:
                content = list(content)
            out.append({"role": message["role"], "content": content})
        return out

    def _faded(self, block: dict, oldest_full: int) -> dict:
        if block.get("type") != "tool_result":
            return block
        origin = self._sense_turn.get(block.get("tool_use_id"))
        if origin is None or origin[0] >= oldest_full:
            return block
        marker = json.dumps({"t": origin[1], "faded": True})
        return {**block, "content": marker}

    def _settle(self, first: int) -> None:
        """A finished turn: thinking becomes text with the same words, in
        place; empty blocks go; a message left empty goes (ARCHITECTURE.md
        decision 3)."""
        settled = self.messages[:first]
        for message in self.messages[first:]:
            if message["role"] != "assistant":
                settled.append(message)
                continue
            content = []
            for block in message["content"]:
                kind = block.get("type")
                if kind == "thinking":
                    if (block.get("thinking") or "").strip():
                        content.append({"type": "text", "text": block["thinking"]})
                elif kind == "redacted_thinking" or _empty_text(block):
                    continue
                else:
                    content.append(block)
            if content:
                settled.append({"role": "assistant", "content": content})
        self.messages = settled

    # --- log -------------------------------------------------------------------
    def _log_thoughts(self, turn: int, content: list[dict]) -> None:
        for block in content:
            kind = block.get("type")
            words = block.get("text") if kind == "text" else block.get("thinking")
            if kind in ("text", "thinking") and (words or "").strip():
                self._log({"type": "thought", "turn": turn, "kind": kind, "text": words})

    def _log(self, event: dict) -> None:
        with self._lock:
            if self.ended:
                return  # nothing from the mind after `close`
            self.world.log.write({"type": event.pop("type"), "t": self.world.t, **event})

    def _end(self, reason: str) -> None:
        with self._lock:
            if self.ended:
                return
            self.ended = True
            self.world.log.write({"type": "close", "t": self.world.t, "reason": reason,
                                  "turns": self.turn, "input_tokens": self.input_tokens,
                                  "output_tokens": self.output_tokens})


def _empty_text(block: dict) -> bool:
    return block.get("type") == "text" and not (block.get("text") or "").strip()


def _tool_result(use: dict, result) -> dict:
    return {"type": "tool_result", "tool_use_id": use.get("id"),
            "content": json.dumps(result, ensure_ascii=False)}
