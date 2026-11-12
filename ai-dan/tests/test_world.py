"""The glue: calls from another thread land on ticks, and a logged session
replays to the same body states with no mind and no API."""
import json
import threading
import time

import pytest

from lab.body import WorldClosed
from lab.config import Config
from lab.log import SessionLog, read_log
from lab.world import ReplayWorld, World, verify_log

BREATH = {"tracks": [{"pins": "all", "keyframes": [[0, 0.2], [2, 0.8], [4, 0.2]], "loop": True}]}


def run_session(path):
    """A short session: a 'mind' on another thread, a person who moves and touches."""
    config = Config()
    log = SessionLog(path)
    log.write_header(config, mind="none")
    world = World(config, log)
    body = world.remote_body()
    answers = []

    def mind():
        answers.append(body.call("sense", {}))
        answers.append(body.call("play", BREATH))
        time.sleep(0.05)
        answers.append(body.call("sense", {}))
        answers.append(body.call("set_color", {"rgb": [255, 120, 40]}))
        answers.append(body.call("play", {"tracks": "nonsense"}))
        time.sleep(0.05)
        answers.append(body.call("sense", {}))
        answers.append(body.call("stop", {"pins": [[0, 0], [7, 7]]}))

    thread = threading.Thread(target=mind)
    thread.start()
    tail = 300
    while thread.is_alive() or tail > 0:
        k = world.body.tick
        person = (4.0, 9.0 + (k % 50) / 50) if k < 2000 else None
        pressed = (3, 3) if 120 <= k % 400 < 170 else None
        world.tick(person, pressed)
        if not thread.is_alive():
            tail -= 1
        elif k % 20 == 0:
            time.sleep(0.001)  # let the mind thread run
    thread.join()
    world.say("hello")
    world.tick(None, None)
    world.close()
    log.close()
    return world, answers


def test_calls_from_the_mind_thread_land_on_ticks(tmp_path):
    world, answers = run_session(tmp_path / "s.jsonl")
    assert len(answers) == 7
    assert answers[1]["ok"] is True
    assert answers[4]["ok"] is False
    calls = [e for e in read_log(tmp_path / "s.jsonl") if e["type"] == "call"]
    assert [c["name"] for c in calls] == ["sense", "play", "sense", "set_color", "play", "sense", "stop"]
    assert all(c["t"] == c["result"]["t"] for c in calls)
    assert world.snapshot().color == (255, 120, 40)


def test_world_tells_the_mind_about_the_person(tmp_path):
    world = World(Config())
    world.tick(None, None)
    world.tick((1.0, 2.0), None)
    world.tick((1.0, 2.5), None)
    world.say("  hello  ")
    world.tick(None, None)
    events = []
    while not world.events.empty():
        events.append(world.events.get())
    assert [e[0] for e in events] == ["enter", "voice", "leave"]
    assert events[1][2] == "hello"


def test_the_clock_starts_when_someone_arrives(tmp_path):
    path = tmp_path / "s.jsonl"
    log = SessionLog(path)
    world = World(Config(), log)
    for _ in range(500):          # ten seconds of an open, empty room
        world.tick(None, None)
    assert world.body.tick == 0 and world.t == 0.0
    world.tick((4.0, 9.0), None)
    world.tick(None, None)        # once begun, time passes whether or not anyone is there
    world.close()
    log.close()
    events = read_log(path)
    assert events[0] == {"type": "person", "tick": 0, "t": 0.0, "pos": [4.0, 9.0]}
    assert world.body.tick == 2


def test_a_session_replays_to_the_same_body_states(tmp_path):
    path = tmp_path / "s.jsonl"
    world, _ = run_session(path)
    report = verify_log(path)
    assert report["ok"], report["mismatches"]
    assert report["calls"] == 7
    assert report["states"] >= 2
    assert report["ticks"] == world.body.tick

    replay = ReplayWorld(read_log(path))
    while not replay.done:
        replay.tick()
    assert replay.body.state_hash() == world.body.state_hash()
    kinds = {e["type"] for e in replay.feed.since(0)}
    assert {"header", "person", "press", "call", "voice"} <= kinds


def test_replay_notices_a_tampered_log(tmp_path):
    path = tmp_path / "s.jsonl"
    run_session(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        event = json.loads(line)
        if event["type"] == "call" and event["name"] == "play" and event["result"]["ok"]:
            event["args"]["tracks"][0]["keyframes"][1][1] = 0.4
            lines[i] = json.dumps(event)
            break
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    report = verify_log(path)
    assert not report["ok"]
    assert report["mismatches"]


def test_a_closed_world_refuses_the_mind():
    world = World(Config())
    body = world.remote_body()
    world.close()
    with pytest.raises(WorldClosed):
        body.call("sense", {})
