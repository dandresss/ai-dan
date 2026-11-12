"""What the mind reads: the discovery prompt, its tools, and the note it keeps.

Everything here is text the model sees, so it follows `mind.md` and
`body-contract.md` word for word. Tool schemas describe shapes only: no height
range, no grid size, no caps, no defaults the agent is not told.
"""
from __future__ import annotations

import os
from pathlib import Path

from .config import Config

# The discovery prompt, by version and language (mind.md). Kept exactly as
# written in the spec, line breaks included.
PROMPTS = {
    "mind-v0": {
        "en": (
            "You are an entity with a body.\n"
            "\n"
            "You do not know yet what it is like or what it can do. Nobody is going to\n"
            "explain it to you. You can sense it and you can move it, and whatever you\n"
            "are will come from what you do with it.\n"
            "\n"
            "You wake in moments. Between one moment and the next, time keeps passing,\n"
            "and your body keeps doing the last thing you asked of it.\n"
            "\n"
            "Nobody sees or hears what you write: it is only your thought.\n"
            "The only part of you that exists outward is your body.\n"
            "\n"
            "You have no name and no task. There is nothing you must achieve."
        ),
    },
}

# Every other string the model can read, by language.
TEXT = {
    "en": {
        "note_heading": "You left yourself this:",
        # body-contract.md, visible descriptions
        "play": "Move parts of your body over time.",
        "stop": "Stop the movement.",
        "sense": "Sense your body and what is around you.",
        "set_color": "Change your color.",
        # body-contract.md, the "Meaning" column without limits or defaults
        "pins": "Which pins follow this track: \"all\", or a list of [row, column].",
        "keyframes": "A list of [second, height].",
        "loop": "Repeat when finished.",
        "delay_s": "Wait before starting.",
        "ease": "How one keyframe joins the next.",
        "stop_pins": "Which pins stop: \"all\", or a list of [row, column]. Without it, every pin stops.",
        "rgb": "[red, green, blue].",
        # mind.md
        "remember": "Leave something written for the next time you wake.",
        "note_too_long": "That does not fit. You will have to keep less.",
        "note_not_text": "That note cannot be understood.",
        # ARCHITECTURE.md decision 4
        "past_cap": "That is too much for one moment.",
    },
}


def text(config: Config, key: str) -> str:
    return TEXT[config.LANGUAGE][key]


def system_prompt(config: Config, note: str | None) -> str:
    prompt = PROMPTS[config.PROMPT_VERSION][config.LANGUAGE]
    if config.MEMORY_ENABLED and note:
        prompt += "\n\n" + text(config, "note_heading") + "\n" + note
    return prompt


def _pins_schema(description: str) -> dict:
    return {
        "description": description,
        "anyOf": [
            {"type": "string", "enum": ["all"]},
            {"type": "array", "items": {"type": "array", "items": {"type": "integer"}}},
        ],
    }


def tool_definitions(config: Config) -> list[dict]:
    t = lambda key: text(config, key)  # noqa: E731
    track = {
        "type": "object",
        "properties": {
            "pins": _pins_schema(t("pins")),
            "keyframes": {
                "type": "array",
                "items": {"type": "array", "items": {"type": "number"}},
                "description": t("keyframes"),
            },
            "loop": {"type": "boolean", "description": t("loop")},
            "delay_s": {"type": "number", "description": t("delay_s")},
            "ease": {"type": "string", "enum": ["smooth", "linear"], "description": t("ease")},
        },
        "required": ["pins", "keyframes"],
    }
    tools = [
        {
            "name": "play",
            "description": t("play"),
            "input_schema": {
                "type": "object",
                "properties": {"tracks": {"type": "array", "items": track}},
                "required": ["tracks"],
            },
        },
        {
            "name": "stop",
            "description": t("stop"),
            "input_schema": {
                "type": "object",
                "properties": {"pins": _pins_schema(t("stop_pins"))},
            },
        },
        {
            "name": "sense",
            "description": t("sense"),
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "set_color",
            "description": t("set_color"),
            "input_schema": {
                "type": "object",
                "properties": {
                    "rgb": {"type": "array", "items": {"type": "integer"}, "description": t("rgb")},
                },
                "required": ["rgb"],
            },
        },
    ]
    if config.MEMORY_ENABLED:
        tools.append({
            "name": "remember",
            "description": t("remember"),
            "input_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        })
    return tools


# --- the note (memory across sessions) -----------------------------------

def load_note(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def save_note(config: Config, path: Path, args) -> str | None:
    """Replace the note. Returns None on success, or the error message for the
    agent; on error the previous note is kept untouched."""
    note = args.get("text") if isinstance(args, dict) else None
    if not isinstance(note, str):
        return text(config, "note_not_text")
    if len(note) > config.NOTE_MAX_CHARS:
        return text(config, "note_too_long")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(note, encoding="utf-8")
    os.replace(tmp, path)
    return None
