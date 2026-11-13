"""Export what the Python mind produces, so web/lab/mind.js can be checked
against it. Run from web/:  ../.venv/Scripts/python.exe tests/fixtures/make_mind_fixtures.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))   # ai-dan/, so `import lab` works

from lab.config import Config  # noqa: E402
from lab.mind import TEXT, system_prompt, tool_definitions  # noqa: E402
from lab.model import thinking_param  # noqa: E402

NOTE = "I rose once.\nThe second line: \"quoted\", and a snowman ☃."

modes = {
    "first_day": (Config(), None),
    "memory_no_note": (Config(MEMORY_ENABLED=True), None),
    "memory_with_note": (Config(MEMORY_ENABLED=True), NOTE),
}

fixture = {
    "note": NOTE,
    "modes": {
        name: {
            "system_prompt": system_prompt(config, note),
            "tool_definitions": tool_definitions(config),
        }
        for name, (config, note) in modes.items()
    },
    "thinking_param": {
        "adaptive": thinking_param(Config()),
        "between_tools": thinking_param(Config(THINKING="between_tools")),
    },
    "TEXT": TEXT,
}

out = HERE / "mind.json"
out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("wrote", out)
