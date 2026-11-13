"""Open the room. `main.py` at the project root calls this.

    uv run main.py                  the lab in a web page at http://localhost:8080; a mind wakes
                                    on the ANTHROPIC_API_KEY in .env
    uv run main.py --desktop        the desktop room: a live session in a window
    uv run main.py --dry-run        the desktop room with a scripted mind: a wiring test, not an AI
    uv run main.py --replay FILE    watch a recorded session again in the desktop room, without the API
    uv run main.py --verify FILE    check that a log replays to the same body states
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _parse(argv):
    ap = argparse.ArgumentParser(prog="uv run main.py", description="A body to wake up in: the virtual lab. "
                                 "With no options it opens the lab in a web page at http://localhost:8080.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="desktop keys: Tab observer panel, F1 help, F2 hide text, F11 fullscreen, Esc quit")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--desktop", action="store_true", help="a live session in the desktop room instead of the web page")
    mode.add_argument("--dry-run", action="store_true",
                      help="the desktop room with a scripted mind (a wiring test, not an AI)")
    mode.add_argument("--replay", metavar="FILE", help="replay a session log, without the API")
    mode.add_argument("--verify", metavar="FILE", help="replay a log headlessly and check the body states")
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed (default 1)")
    ap.add_argument("--memory", action="store_true", help="turn memory across sessions on")
    ap.add_argument("--model", metavar="NAME", help="model to wake (default from config)")
    ap.add_argument("--frames", type=int, metavar="N", help="quit after N frames (for tests)")
    ap.add_argument("--shot", metavar="PATH", help="save the last frame as a PNG")
    ap.add_argument("--visitor", action="store_true",
                    help="a scripted person instead of the mouse, for headless tests")
    ap.add_argument("--size", default="1280x800", help="window size, WIDTHxHEIGHT")
    ap.add_argument("--port", type=int, default=8080, help="web page: the port on localhost (default 8080)")
    ap.add_argument("--no-browser", action="store_true", help="web page: do not open the browser")
    args = ap.parse_args(argv)
    desktop_only = [flag for flag, used in (("--memory", args.memory), ("--model", args.model),
                                            ("--frames", args.frames is not None), ("--shot", args.shot),
                                            ("--visitor", args.visitor), ("--speed", args.speed != 1.0))
                    if used]
    if desktop_only and not (args.desktop or args.dry_run or args.replay or args.verify):
        ap.error(f"{', '.join(desktop_only)} belong to the desktop room: add --desktop "
                 "(in the web page, later-days mode is a switch under Wake a mind)")
    return args


def _shown(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def _load_env() -> None:
    from .config import ROOT
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(ROOT / ".env")


def _app_options(args) -> dict:
    from .app import ScriptedVisitor
    size = tuple(int(v) for v in args.size.lower().split("x"))
    return {"frames": args.frames, "shot": args.shot, "size": size,
            "visitor": ScriptedVisitor() if args.visitor else None}


def verify(path: str) -> int:
    from .world import verify_log
    result = verify_log(path)
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


def replay(args) -> int:
    from .app import App
    from .log import read_log
    from .world import ReplayWorld
    world = ReplayWorld(read_log(args.replay))
    App(world, "replay", replay_name=Path(args.replay).name, speed=args.speed,
        **_app_options(args)).run()
    if world.mismatches:
        print(f"replay differed from the log in {len(world.mismatches)} places; "
              f"run --verify for details", file=sys.stderr)
    return 0


def live(args) -> int:
    from .app import App
    from .config import NOTE_PATH, Config
    from .log import SessionLog, new_log_path
    from .world import World

    _load_env()
    config = Config.from_env()
    if args.memory:
        config.MEMORY_ENABLED = True
    if args.model:
        config.MODEL = args.model

    log_path = new_log_path()
    log = SessionLog(log_path)
    world = World(config, log)
    mode = "dryrun" if args.dry_run else "live"
    harness, detail = None, None
    try:
        from . import model as model_module
        model = model_module.ScriptedModel(config) if args.dry_run else model_module.make_model(config)
        if model is not None:
            from .harness import Harness
            harness = Harness(world, model, config, note_path=NOTE_PATH)
            harness.start()
    except Exception as exc:   # the mind's modules are young; keep the body usable
        print(f"the mind could not be started: {type(exc).__name__}: {exc}", file=sys.stderr)
        harness = None
        detail = f"the mind's code could not be started ({type(exc).__name__}: {exc})."

    if harness is None:
        mode = "nokey"
        log.write_header(config, t=world.t, prompt_version=config.PROMPT_VERSION, prompt=None,
                         model=None, tools=[], memory_enabled=config.MEMORY_ENABLED, mind="none")
    try:
        App(world, mode, log_path=_shown(log_path), nokey_detail=detail, **_app_options(args)).run()
    finally:
        # The world first: a call the mind is still waiting on is released at
        # once, so the mind thread can finish instead of waiting for a tick.
        world.close()
        if harness is not None:
            harness.stop("window_closed")
        log.close()
        print(f"session log: {_shown(log_path)}")
    return 0


def main(argv=None) -> int:
    args = _parse(argv)
    if args.verify:
        return verify(args.verify)
    if args.replay:
        return replay(args)
    if args.desktop or args.dry_run:
        return live(args)
    from .web import serve
    return serve(args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    sys.exit(main())
