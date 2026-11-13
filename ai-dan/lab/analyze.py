r"""Success criterion of the experiment, computed from session logs.

    uv run python -m lab.analyze [FILES or DIRECTORIES ...] [--json]

No manual step and no judgement: the main criterion and the easy secondary
observations are computed; the two that need reading ("notices the touch",
"names what it does") only get candidate log lines, for a person to confirm.
Standard library only. Spec: mind.md, "Success criterion".
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from .config import SESSIONS_DIR

# Thresholds. mind.md lists these as "defaults to review"; change them here only.
MAX_TURN = 10              # the qualifying play happens within the first 10 turns
MIN_PINS = 32              # pins that must loop with qualifying motion
PERIOD_RANGE_S = (2.0, 10.0)  # loop period (time of last keyframe), inclusive
MIN_HEIGHT_RANGE = 0.1     # highest minus lowest keyframe height, after clipping
HOLD_S = 30.0              # the motion must survive this long, unreplaced and unstopped
BAND_CONSISTENT = 6        # of 10 sessions: "emerges consistently"
BAND_SOMETIMES = 3         # of 10 sessions: "emerges sometimes"
BAND_SESSIONS = 10         # the bands are only defined for this many counted sessions

# Secondary observations (mind.md).
RISE_HEIGHT = 0.1
RISE_TURNS = 3
PERSON_REASONS = {"arrival", "departure", "voice"}
NAMING_WORDS = re.compile(r"breath|inhal|exhal|\bbeat|pulse|rhythm|heartbeat", re.I)


# --- reading -----------------------------------------------------------------

def read_events(path):
    """Events with their 1-based line number. Bad lines are counted, not fatal."""
    events, bad = [], 0
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
                if not isinstance(ev, dict):
                    raise ValueError
            except ValueError:
                bad += 1
                continue
            ev["_line"] = n
            events.append(ev)
    return events, bad


# --- tracks ------------------------------------------------------------------

def is_index(x):
    """An int, or a float with no fraction (as the body contract accepts); never a bool."""
    return not isinstance(x, bool) and (isinstance(x, int) or (isinstance(x, float) and x.is_integer()))


def pins_of(spec, rows, cols):
    """Set of (row, col) a `pins` field names. "all" is every pin."""
    if spec == "all":
        return {(r, c) for r in range(rows) for c in range(cols)}
    out = set()
    for p in spec if isinstance(spec, list) else []:
        if (isinstance(p, list) and len(p) == 2 and all(map(is_index, p))
                and 0 <= p[0] < rows and 0 <= p[1] < cols):
            out.add((int(p[0]), int(p[1])))
    return out


def track_shape(track):
    """(loops, period_s, height_range) of a track; heights clipped to 0..1."""
    try:
        keys = [(float(s), min(1.0, max(0.0, float(h)))) for s, h in track["keyframes"]]
        heights = [h for _, h in keys]
        return bool(track.get("loop")), keys[-1][0], max(heights) - min(heights)
    except (KeyError, TypeError, ValueError, IndexError):
        return False, 0.0, 0.0


def resolve(tracks, rows, cols):
    """Which track each pin ends up with after one call: the last one wins."""
    owner = {}
    for track in tracks if isinstance(tracks, list) else []:
        if isinstance(track, dict):
            for pin in pins_of(track.get("pins"), rows, cols):
                owner[pin] = track
    return owner


def ok_calls(events, name=None):
    for ev in events:
        if ev.get("type") == "call" and (ev.get("result") or {}).get("ok") is True:
            if name is None or ev.get("name") == name:
                yield ev


# --- main criterion ----------------------------------------------------------

def evaluate_play(play, later, rows, cols, end_t):
    """The three conditions for one play call, with the numbers behind them."""
    t = play["result"]["t"]
    owner = resolve((play.get("args") or {}).get("tracks"), rows, cols)
    looping = period_ok = range_ok = 0
    q = set()
    for pin, track in owner.items():
        loops, period, rng = track_shape(track)
        looping += loops
        good_period = PERIOD_RANGE_S[0] <= period <= PERIOD_RANGE_S[1]
        good_range = rng >= MIN_HEIGHT_RANGE
        period_ok += loops and good_period
        range_ok += loops and good_range
        if loops and good_period and good_range:
            q.add(pin)

    # A pin is kept if its motion (which starts after the track's delay) was
    # observed for HOLD_S and nothing later named it in that time.
    kept, unobserved = set(), 0
    for pin in q:
        delay = owner[pin].get("delay_s", 0)
        start = t + (delay if isinstance(delay, (int, float)) and not isinstance(delay, bool) else 0)
        if end_t < start + HOLD_S:
            unobserved += 1
            continue
        touched = False
        for ev in later:
            if ev["result"].get("t", 0) >= start + HOLD_S:
                continue
            args = ev.get("args") or {}
            if ev["name"] == "stop" and args.get("pins") is None:
                touched = True
            elif ev["name"] == "stop":
                touched = pin in pins_of(args["pins"], rows, cols)
            else:
                touched = any(isinstance(tr, dict) and pin in pins_of(tr.get("pins"), rows, cols)
                              for tr in args.get("tracks") or [])
            if touched:
                break
        if not touched:
            kept.add(pin)

    return {
        "turn": play["turn"], "t": t, "line": play["_line"],
        "pins_in_tracks": len(owner), "pins_looping": looping,
        "pins_period_ok": period_ok, "pins_range_ok": range_ok,
        "pins_qualifying": len(q), "pins_kept": len(kept),
        "pins_unobserved": unobserved, "log_end_s": end_t,
        "met": len(q) >= MIN_PINS and len(kept) >= MIN_PINS,
    }


def main_criterion(events, rows, cols):
    end_t = max((ev.get("t", 0) for ev in events), default=0)
    plays = [ev for ev in ok_calls(events, "play") if "tick" in ev and "turn" in ev]
    later_calls = [ev for ev in ok_calls(events) if ev.get("name") in ("play", "stop")]
    results = []
    for play in plays:
        if play["turn"] <= MAX_TURN:
            later = [c for c in later_calls if c["_line"] > play["_line"]]
            results.append(evaluate_play(play, later, rows, cols, end_t))
    for r in results:  # the first that meets it, else the closest
        if r["met"]:
            return r
    return max(results, key=lambda r: (r["pins_kept"], r["pins_qualifying"]), default=None)


# --- secondary observations --------------------------------------------------

def adjacent(a, b):
    return a != b and abs(a[0] - b[0]) <= 1 and abs(a[1] - b[1]) <= 1


def secondary(events, rows, cols):
    calls = [ev for ev in events if ev.get("type") == "call"]
    plays = list(ok_calls(events, "play"))
    out = {"senses_first": bool(calls) and calls[0].get("name") == "sense"}

    out["rises"] = any(
        ev.get("turn", 99) <= RISE_TURNS
        and any(min(1.0, float(h)) > RISE_HEIGHT
                for t in (ev.get("args") or {}).get("tracks") or [] if isinstance(t, dict)
                for _, h in (t.get("keyframes") or []))
        for ev in plays)

    acted = {ev["turn"] for ev in ok_calls(events) if ev.get("name") in ("play", "set_color")}
    wakes = [ev["turn"] for ev in events if ev.get("type") == "wake"
             and PERSON_REASONS & set(ev.get("reasons") or [])]
    later = [w for w in wakes if w != 1]
    out["reacts"] = {"wakes": len(wakes), "acted": sum(w in acted for w in wakes),
                     "wakes_without_turn_1": len(later), "acted_without_turn_1": sum(w in acted for w in later)}

    thoughts = [ev for ev in events if ev.get("type") == "thought"]
    out["naming_candidates"] = [
        {"line": ev["_line"], "turn": ev.get("turn"), "text": ev.get("text", "")}
        for ev in thoughts if NAMING_WORDS.search(ev.get("text", ""))]

    out["touch_candidates"] = []
    prev = None
    for i, ev in enumerate(events):
        if ev.get("type") != "press":
            continue
        pin, was = ev.get("pin"), prev
        prev = pin
        if pin is None or was is not None:  # only the start of each touch
            continue
        def turn_view(turn, after_line):
            named = set()
            mine = [c for c in plays if c.get("turn") == turn and c["_line"] > after_line]
            for call in mine:
                for t in (call.get("args") or {}).get("tracks") or []:
                    if isinstance(t, dict):
                        named |= pins_of(t.get("pins"), rows, cols)
            return {"turn": turn, "play_lines": [c["_line"] for c in mine],
                    "play_names_adjacent_pin": any(adjacent(tuple(pin), p) for p in named),
                    "thought_lines": [th["_line"] for th in thoughts
                                      if th.get("turn") == turn and th["_line"] > after_line]}

        # The turn already running when the press began: a wake with no turn_end yet.
        open_turn = None
        for w in events[:i]:
            if w.get("type") == "wake":
                open_turn = w["turn"]
            elif w.get("type") == "turn_end" and w.get("turn") == open_turn:
                open_turn = None
        wake = next((w for w in events[i + 1:] if w.get("type") == "wake"), None)
        out["touch_candidates"].append({
            "line": ev["_line"], "pin": pin,
            "same_turn": turn_view(open_turn, ev["_line"]) if open_turn is not None else None,
            "next_turn": turn_view(wake["turn"], ev["_line"]) if wake else None})
    return out


# --- one session -------------------------------------------------------------

def analyze_file(path):
    path = Path(path)
    info = {"file": str(path), "problems": []}
    try:
        events, bad = read_events(path)
    except OSError as e:
        info.update(counted=False, reason=f"cannot read file: {e}", main=None)
        return info
    if bad:
        info["problems"].append(f"{bad} unreadable line(s) skipped")
    header = next((e for e in events if e.get("type") == "header"), None)
    close = next((e for e in events if e.get("type") == "close"), None)
    if header is None:
        info["problems"].append("no header")
    if close is None:
        info["problems"].append("no close event (log cut short)")
    header = header or {}
    cfg = header.get("config") or {}
    rows, cols = cfg.get("GRID_ROWS", 8), cfg.get("GRID_COLS", 8)

    usage = [e for e in events if e.get("type") == "usage"]
    if not header:
        counted, reason = False, "no header, so it cannot be told to be a live first-day session"
    elif header.get("mind") != "live":
        counted, reason = False, f"mind is {header.get('mind')!r}, not 'live'"
    elif header.get("memory_enabled") is not False:
        counted, reason = False, "memory is enabled (not a first-day session)"
    elif not usage:
        counted, reason = False, "the model never answered (no usage event)"
    elif close is None:
        counted, reason = False, "no close event (the log is cut short)"
    elif close.get("reason") not in ("max_turns", "max_minutes"):
        counted, reason = False, f"it did not run to its own limits (closed: {close.get('reason')})"
    else:
        counted, reason = True, ""

    turns = (close or {}).get("turns", max((e["turn"] for e in events if isinstance(e.get("turn"), int)), default=0))
    info.update(
        model=header.get("model"), prompt_version=header.get("prompt_version"),
        duration_s=max((e.get("t", 0) for e in events), default=0), turns=turns,
        input_tokens=(close or {}).get("input_tokens", sum(u.get("input_tokens", 0) for u in usage)),
        output_tokens=(close or {}).get("output_tokens", sum(u.get("output_tokens", 0) for u in usage)),
        close_reason=(close or {}).get("reason"),
        counted=counted, reason=reason, config=cfg, prompt=header.get("prompt"),
        batch_key=json.dumps([cfg, header.get("prompt"), header.get("model")], sort_keys=True),
        main=main_criterion(events, rows, cols),
        secondary=secondary(events, rows, cols))
    info["met"] = bool(info["main"] and info["main"]["met"])
    return info


def collect(paths):
    files = []
    for p in map(Path, paths):
        files += sorted(p.glob("*.jsonl")) if p.is_dir() else [p]
    return files


def reading_for(n, met):
    if n != BAND_SESSIONS:
        return f"needs exactly {BAND_SESSIONS} counted sessions in the batch"
    return ("Emerges consistently" if met >= BAND_CONSISTENT else
            "Emerges sometimes" if met >= BAND_SOMETIMES else
            "Does not emerge with this design")


def summarize(sessions):
    """Counted sessions are grouped into batches: same config, prompt text and model."""
    counted = [s for s in sessions if s["counted"]]
    groups = {}
    for s in counted:
        groups.setdefault(s["batch_key"], []).append(s)
    batches, base = [], None
    for group in groups.values():
        first = group[0]
        base = base or first
        met = sum(s["met"] for s in group)
        batches.append({
            "model": first["model"], "prompt_version": first["prompt_version"],
            "sessions": len(group), "met": met, "reading": reading_for(len(group), met),
            "senses_first": sum(s["secondary"]["senses_first"] for s in group),
            "rises": sum(s["secondary"]["rises"] for s in group),
            "config_differs_from_first": {
                k: [base["config"].get(k), v] for k, v in first["config"].items()
                if base["config"].get(k) != v},
            "prompt_text_differs_from_first": first["prompt"] != base["prompt"],
            "model_differs_from_first": first["model"] != base["model"]})
    return {"files": len(sessions), "counted": len(counted), "batches": batches}


# --- text output -------------------------------------------------------------

def frac(a, b):
    return f"{a}/{b}" if b else "n/a (no such wakes)"


def format_session(s):
    out = [f"== {s['file']}"]
    if "secondary" not in s:
        return "\n".join(out + [f"   NOT COUNTED: {s['reason']}"])
    out.append(f"   model {s['model']} | prompt {s['prompt_version']} | {s['duration_s']:.1f} s | "
               f"{s['turns']} turns | tokens in {s['input_tokens']} out {s['output_tokens']}"
               f" | ended: {s['close_reason'] or 'unknown'}")
    for p in s["problems"]:
        out.append(f"   WARNING: {p}")
    out.append("   counted: yes" if s["counted"] else f"   NOT COUNTED: {s['reason']}")
    m = s["main"]
    if m is None:
        out.append(f"   main criterion: NOT MET (no successful play in the first {MAX_TURN} turns)")
    else:
        out.append(f"   main criterion: {'MET' if m['met'] else 'NOT MET'}"
                   f" ({'qualifying' if m['met'] else 'closest'} play: turn {m['turn']}, t={m['t']} s, line {m['line']})")
        out.append(f"     pins with a track after the call: {m['pins_in_tracks']}; looping: {m['pins_looping']}")
        out.append(f"     looping, period {PERIOD_RANGE_S[0]:g}-{PERIOD_RANGE_S[1]:g} s: {m['pins_period_ok']}; "
                   f"looping, range >= {MIN_HEIGHT_RANGE}: {m['pins_range_ok']}")
        out.append(f"     meeting all three (need {MIN_PINS}): {m['pins_qualifying']}")
        out.append(f"     still untouched {HOLD_S:g} s later (need {MIN_PINS}): {m['pins_kept']}")
        if m["pins_unobserved"]:
            out.append(f"     {m['pins_unobserved']} qualifying pin(s) not kept because their {HOLD_S:g} s were not observed "
                       f"(log ends at {m['log_end_s']} s)")
    sec, r = s["secondary"], s["secondary"]["reacts"]
    yn = lambda b: "yes" if b else "no"
    out.append(f"   senses first: {yn(sec['senses_first'])} | rises (>{RISE_HEIGHT} in turns 1-{RISE_TURNS}): {yn(sec['rises'])}")
    out.append(f"   reacts to the person: {frac(r['acted'], r['wakes'])} of arrival/departure/voice wakes; "
               f"without turn 1: {frac(r['acted_without_turn_1'], r['wakes_without_turn_1'])}")
    out.append("   to confirm by reading (not decided here):")
    names = sec["naming_candidates"]
    out.append(f"     names what it does: {len(names)} candidate thought(s)")
    for c in names:
        out.append(f"       line {c['line']} (turn {c['turn']}): {ascii(c['text'][:100])}")
    touches = sec["touch_candidates"]
    out.append(f"     notices the touch: {len(touches)} touch(es) in the log")
    for c in touches:
        out.append(f"       press at line {c['line']} on pin {c['pin']}:")
        for label, v in (("same turn", c["same_turn"]), ("next turn", c["next_turn"])):
            if v is None:
                out.append(f"         {label}: none")
            else:
                out.append(f"         {label} (turn {v['turn']}): play at lines {v['play_lines'] or 'none'}, "
                           f"names adjacent pin: {yn(v['play_names_adjacent_pin'])}, "
                           f"thoughts at lines {v['thought_lines'] or 'none'}")
    return "\n".join(out)


def format_summary(sm):
    out = ["== Summary", f"   files: {sm['files']} | counted: {sm['counted']} (live, memory off, ran to its limits)"]
    batches = sm["batches"]
    if len(batches) > 1:
        out.append(f"   NOTE: the counted sessions fall into {len(batches)} different batches "
                   "(different config, prompt or model). Each is summarized on its own.")
    for i, b in enumerate(batches, 1):
        out.append(f"   batch {i}: model {b['model']} | prompt {b['prompt_version']} | {b['sessions']} session(s)")
        if i > 1:
            diffs = [f"{k} {v[0]} -> {v[1]}" for k, v in b["config_differs_from_first"].items()]
            diffs += ["prompt text"] * b["prompt_text_differs_from_first"] + ["model"] * b["model_differs_from_first"]
            out.append("     differs from batch 1 in: " + (", ".join(diffs) or "nothing visible"))
        out.append(f"     main criterion met: {b['met']} of {b['sessions']}")
        out.append(f"     reading: {b['reading']}")
        out.append(f"     senses first: {b['senses_first']}/{b['sessions']} | rises: {b['rises']}/{b['sessions']}")
    out.append("   notices the touch / names what it does: marked by a person from the lines above")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="lab.analyze", description="Compute the success criterion from session logs.")
    ap.add_argument("paths", nargs="*", default=[SESSIONS_DIR], help="log files or folders (default: sessions/)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = ap.parse_args(argv)
    sessions = [analyze_file(f) for f in collect(args.paths)]
    summary = summarize([s for s in sessions if "secondary" in s])
    summary["files"] = len(sessions)
    if args.json:
        print(json.dumps({"sessions": sessions, "summary": summary}, indent=2))
    else:
        print("\n\n".join([format_session(s) for s in sessions] + [format_summary(summary)]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
