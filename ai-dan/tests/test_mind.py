"""What the mind reads, checked against the spec files themselves."""
from __future__ import annotations

import json
import re

from harness_fakes import FakeModel, FakeWorld, response, use

from lab.config import ROOT, Config
from lab.harness import Harness
from lab.mind import PROMPTS, load_note, save_note, system_prompt, tool_definitions

SPECS = ROOT.parent


def spec_prompt() -> str:
    text = (SPECS / "mind.md").read_text(encoding="utf-8")
    block = text.split("## Discovery prompt, version `mind-v0`", 1)[1]
    return block.split("```", 2)[1].strip("\n")


def contract_descriptions() -> dict:
    text = (SPECS / "body-contract.md").read_text(encoding="utf-8")
    return dict(re.findall(r'### `(\w+)`\s+Visible description: "([^"]+)"', text))


def test_prompt_is_the_spec_word_for_word():
    assert PROMPTS["mind-v0"]["en"] == spec_prompt()
    assert system_prompt(Config(), None) == spec_prompt()


def test_body_tool_descriptions_are_the_contract_word_for_word():
    tools = {t["name"]: t["description"] for t in tool_definitions(Config())}
    assert tools == contract_descriptions()


def test_remember_description_is_the_spec_word_for_word():
    mind = (SPECS / "mind.md").read_text(encoding="utf-8")
    tools = {t["name"]: t for t in tool_definitions(Config(MEMORY_ENABLED=True))}
    assert f'Visible description: "{tools["remember"]["description"]}"' in mind


def test_schemas_say_shapes_not_limits():
    for config in (Config(), Config(MEMORY_ENABLED=True)):
        for tool in tool_definitions(config):
            schema = json.dumps(tool["input_schema"])
            for word in ("minimum", "maximum", "minItems", "maxItems", "maxLength", "default"):
                assert word not in schema, (tool["name"], word)
            for description in re.findall(r'"description": "((?:[^"\\]|\\.)*)"', schema):
                assert not re.search(r"\d", description), (tool["name"], description)
    play = tool_definitions(Config())[0]["input_schema"]
    track = play["properties"]["tracks"]["items"]
    assert set(track["properties"]) == {"pins", "keyframes", "loop", "delay_s", "ease"}
    assert track["required"] == ["pins", "keyframes"]
    assert track["properties"]["ease"]["enum"] == ["smooth", "linear"]


def test_first_day_mode_has_no_remember_and_no_note(tmp_path):   # mind.md criterion 2
    note = tmp_path / "note.txt"
    note.write_text("I was here", encoding="utf-8")
    config = Config()
    assert "remember" not in [t["name"] for t in tool_definitions(config)]
    assert system_prompt(config, "I was here") == spec_prompt()

    world, model = FakeWorld(), FakeModel()
    h = Harness(world, model, config, note_path=note)
    h.start(run_thread=False)
    world.enter()
    h.step()
    assert model.systems[0] == spec_prompt()
    assert [t["name"] for t in model.tools[0]] == ["play", "stop", "sense", "set_color"]


def test_a_note_carries_to_the_next_session(tmp_path):   # mind.md criterion 3
    note = tmp_path / "memory" / "note.txt"
    config = Config(MEMORY_ENABLED=True)

    world, model = FakeWorld(), FakeModel([response(use("remember", {"text": "I rose once."}))])
    first = Harness(world, model, config, note_path=note)
    first.start(run_thread=False)
    world.enter()
    first.step()
    assert model.systems[0] == spec_prompt()      # no note yet
    assert "remember" in [t["name"] for t in model.tools[0]]
    first.stop()

    world, model = FakeWorld(), FakeModel()
    second = Harness(world, model, config, note_path=note)
    second.start(run_thread=False)
    world.enter()
    second.step()
    assert model.systems[0] == spec_prompt() + "\n\nYou left yourself this:\nI rose once."
    assert world.logged("header")[0]["prompt"] == model.systems[0]


def test_a_note_over_the_cap_is_rejected_and_the_old_one_kept(tmp_path):   # mind.md criterion 4
    note = tmp_path / "note.txt"
    config = Config(MEMORY_ENABLED=True)
    assert save_note(config, note, {"text": "keep this"}) is None
    error = save_note(config, note, {"text": "x" * 1501})
    assert error == "That does not fit. You will have to keep less."
    assert load_note(note) == "keep this"
    assert save_note(config, note, {"text": "y" * 1500}) is None
    assert load_note(note) == "y" * 1500


def test_a_rejected_note_through_the_harness(tmp_path):
    note = tmp_path / "note.txt"
    note.write_text("old", encoding="utf-8")
    world = FakeWorld()
    model = FakeModel([response(use("remember", {"text": "z" * 2000})),
                       response(use("remember", {"text": 7}))])
    h = Harness(world, model, Config(MEMORY_ENABLED=True), note_path=note)
    h.start(run_thread=False)
    world.enter()
    h.step()
    results = [e["result"] for e in world.logged("call")]
    assert results[0] == {"ok": False, "t": 0.0,
                          "error": "That does not fit. You will have to keep less."}
    assert results[1]["ok"] is False
    assert load_note(note) == "old"


def test_no_note_file_means_no_note(tmp_path):
    assert load_note(tmp_path / "missing.txt") is None
    assert load_note(None) is None
    config = Config(MEMORY_ENABLED=True)
    assert system_prompt(config, None) == spec_prompt()
    assert system_prompt(config, "") == spec_prompt()
