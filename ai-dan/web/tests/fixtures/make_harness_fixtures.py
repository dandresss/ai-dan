"""Run the Python harness through the scenarios in harness_scenarios.json and
record what it logs and what it sends to the model, so web/lab/harness.js can
be checked against Python output (tests/harness.test.js, "against Python").

Run from web/:  ../.venv/Scripts/python.exe tests/fixtures/make_harness_fixtures.py

A scenario is a model script, a few knobs and a list of operations on a fake
world with a clock the scenario controls:

    config      Config overrides
    dtPerCall   seconds of lab time each model call takes
    callS       seconds each body call takes (default 0)
    script      model answers, in order: {"r": [blocks], "stop": ...},
                {"err": message, "retry": bool} or {"exc": message}
    ops         ["enter"] ["leave"] ["say", text] ["t", seconds] ["step"] ["stop", reason?]
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]                      # ai-dan/
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))     # harness_fakes

import harness_fakes  # noqa: E402

# Some scenarios send blank text on purpose, which the validity check rejects.
harness_fakes.assert_valid = lambda messages: None

from harness_fakes import FakeModel, FakeWorld  # noqa: E402
from lab.config import Config  # noqa: E402
from lab.harness import Harness  # noqa: E402
from lab.model import ModelError, ModelResponse  # noqa: E402


def answer(item):
    if "r" in item:
        stop = item.get("stop") or ("tool_use" if any(b["type"] == "tool_use" for b in item["r"])
                                    else "end_turn")
        return ModelResponse(content=item["r"], stop_reason=stop, model="fake",
                             input_tokens=10, output_tokens=5)
    if "err" in item:
        return ModelError(item["err"], item["retry"])
    return TypeError(item["exc"])


def run(scenario):
    world = FakeWorld()
    world.call_s = scenario.get("callS", 0.0)

    def on_call(n, dt=scenario["dtPerCall"]):
        world.t = round(world.t + dt, 2)

    model = FakeModel([answer(item) for item in scenario["script"]], on_call=on_call)
    harness = Harness(world, model, Config(**scenario["config"]))
    waits = []
    harness.sleep = waits.append
    harness.start(run_thread=False)
    for op in scenario["ops"]:
        kind = op[0]
        if kind == "enter":
            world.enter()
        elif kind == "leave":
            world.leave()
        elif kind == "say":
            world.say(op[1])
        elif kind == "t":
            world.t = float(op[1])
        elif kind == "step":
            harness.step()
        elif kind == "stop":
            harness.stop(*op[1:])
    return {
        "lines": [json.dumps(e, ensure_ascii=False) for e in world.log.feed.since(0)],
        "sent": [json.dumps(m, ensure_ascii=False) for m in model.sent],
        "systems": model.systems,
        "waits": waits,
    }


scenarios = json.loads((HERE / "harness_scenarios.json").read_text(encoding="utf-8"))
fixture = [{**scenario, "expected": run(scenario)} for scenario in scenarios]
out = HERE / "harness.json"
out.write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print("wrote", out)
