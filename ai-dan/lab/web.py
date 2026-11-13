"""The lab in a web page, served from this machine: `uv run main.py`.

Serves `web/` at http://localhost:8080 and answers the page's `/api/mind`
with the key in `.env`, so the page never asks for one. It is the local twin
of `web/api/mind.js`: the same checks, the same answers, but no access code,
because only this machine can reach it. It listens on 127.0.0.1 only and
refuses requests that come from any other web page.
"""
from __future__ import annotations

import json
import os
import re
import socket
import threading
import urllib.error
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .config import ROOT, Config
from .mind import system_prompt, text, tool_definitions
from .model import _load_dotenv, thinking_param

WEB_DIR = ROOT / "web"
API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_PORT = 8080

MAX_REQUEST_BYTES = 2_000_000   # a full 40-turn history stays well under this
UPSTREAM_TIMEOUT_S = 140        # the browser gives up at 120 s
MAX_HEARD_LINES = 20            # lines the person said between two wakes
MAX_HEARD_CHARS = 200           # the page's limit for one line
MAX_TEXT_CHARS = 20_000         # one block of the mind's own text or thinking
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


# --- what counts as this lab's request (twin of labRequest in web/api/mind.js) ---

def lab_request(body) -> dict | str:
    """The request to forward, built from the lab's own settings, or an error text."""
    if not isinstance(body, dict):
        return "The request must be an object."
    tools = body.get("tools")
    config = Config()   # the page runs on the defaults too
    config.MEMORY_ENABLED = isinstance(tools, list) and any(
        isinstance(tool, dict) and tool.get("name") == "remember" for tool in tools)
    system = body.get("system")
    if not _is_lab_prompt(config, system):
        return "That is not this lab's system prompt."
    messages = _lab_messages(body.get("messages"))
    if messages is None:
        return "The conversation is not this lab's."
    return {
        "model": config.MODEL,
        "max_tokens": config.MAX_TOKENS,
        "system": system,
        "tools": tool_definitions(config),
        "messages": messages,
        "thinking": thinking_param(config),
        "output_config": {"effort": config.EFFORT},
    }


def _is_lab_prompt(config: Config, system) -> bool:
    if not isinstance(system, str):
        return False
    if system == system_prompt(config, None):
        return True
    if not config.MEMORY_ENABLED:
        return False
    # Later-days mode: the prompt may end with the note the mind left itself.
    prefix = f"{system_prompt(config, None)}\n\n{text(config, 'note_heading')}\n"
    if not system.startswith(prefix):
        return False
    note = system[len(prefix):]
    return 0 < len(note) <= config.NOTE_MAX_CHARS and system_prompt(config, note) == system


def _lab_messages(messages) -> list | None:
    """The conversation rebuilt block by block from the fields the harness writes."""
    if not isinstance(messages, list) or not messages:
        return None
    out = []
    for message in messages:
        if not isinstance(message, dict):
            return None
        content, role = message.get("content"), message.get("role")
        rebuild = {"user": _user_block, "assistant": _assistant_block}.get(role)
        if rebuild is None or not isinstance(content, list) or not content:
            return None
        blocks = [rebuild(block) if isinstance(block, dict) else None for block in content]
        if any(block is None for block in blocks):
            return None
        out.append({"role": role, "content": blocks})
    return out


def _user_block(block: dict) -> dict | None:
    kind = block.get("type")
    if kind == "text" and _is_wake(block.get("text")):
        return {"type": "text", "text": block["text"]}
    if kind == "tool_result" and _is_id(block.get("tool_use_id")) and _is_result(block.get("content")):
        return {"type": "tool_result", "tool_use_id": block["tool_use_id"], "content": block["content"]}
    return None


def _assistant_block(block: dict) -> dict | None:
    kind = block.get("type")
    if kind == "text" and _is_text(block.get("text")):
        return {"type": "text", "text": block["text"]}
    if kind == "thinking" and _is_text(block.get("thinking")) and isinstance(block.get("signature"), str):
        return {"type": "thinking", "thinking": block["thinking"], "signature": block["signature"]}
    if kind == "redacted_thinking" and isinstance(block.get("data"), str):
        return {"type": "redacted_thinking", "data": block["data"]}
    if (kind == "tool_use" and _is_id(block.get("id")) and isinstance(block.get("name"), str)
            and _units(block["name"]) <= 64 and isinstance(block.get("input"), dict)):
        # Unknown tool names are allowed: the mind may call one, and the body answers it.
        return {"type": "tool_use", "id": block["id"], "name": block["name"], "input": block["input"]}
    return None


def _strict_json(words: str):
    """json.loads without NaN or Infinity, like the browser's JSON.parse."""
    def refuse(constant):
        raise ValueError(constant)
    return json.loads(words, parse_constant=refuse)


def _is_wake(words) -> bool:
    """A wake message: {"t": seconds} and, when the person spoke, "heard"."""
    if not isinstance(words, str):
        return False
    try:
        wake = _strict_json(words)
    except ValueError:
        return False
    if not isinstance(wake, dict) or not _is_number(wake.get("t")) or not set(wake) <= {"t", "heard"}:
        return False
    if "heard" not in wake:
        return True
    heard = wake["heard"]
    return (isinstance(heard, list) and len(heard) <= MAX_HEARD_LINES
            and all(isinstance(line, str) and len(line) <= MAX_HEARD_CHARS for line in heard))


def _is_result(content) -> bool:
    """A tool result is the body's (or the note's) answer: a small JSON object with a time."""
    if not isinstance(content, str) or _units(content) > 10_000:
        return False
    try:
        result = _strict_json(content)
    except ValueError:
        return False
    return isinstance(result, dict) and "t" in result and (result["t"] is None or _is_number(result["t"]))


def _is_number(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _is_text(x) -> bool:
    return isinstance(x, str) and _units(x) <= MAX_TEXT_CHARS


def _is_id(x) -> bool:
    return isinstance(x, str) and _ID.fullmatch(x) is not None


def _units(s: str) -> int:
    """Length as JavaScript counts it (UTF-16 code units), so both twins agree."""
    return len(s.encode("utf-16-le")) // 2


# --- talking to the API ---------------------------------------------------------

def forward(request: dict, api_key: str) -> tuple[int, bytes]:
    """POST the request to the Messages API. Returns (status, body); the API's own
    errors pass through, a failure to reach it is a 502 or 504."""
    upstream = urllib.request.Request(
        API_URL, data=json.dumps(request).encode("utf-8"), method="POST",
        headers={"content-type": "application/json", "anthropic-version": "2023-06-01",
                 "x-api-key": api_key})
    try:
        with urllib.request.urlopen(upstream, timeout=UPSTREAM_TIMEOUT_S) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except TimeoutError:
        return 504, _error("api_error", "The model took too long to answer.")
    except (urllib.error.URLError, OSError):
        return 502, _error("api_error", "This machine could not reach the model.")


def _error(kind: str, message: str) -> bytes:
    return json.dumps({"type": "error", "error": {"type": kind, "message": message}}).encode("utf-8")


# --- the server --------------------------------------------------------------------

def _site_headers() -> list[tuple[str, str]]:
    """The security headers the deploy sends (web/vercel.json), so local is the same page."""
    config = json.loads((WEB_DIR / "vercel.json").read_text(encoding="utf-8"))
    for rule in config.get("headers", []):
        if rule.get("source") == "/(.*)":
            return [(h["key"], h["value"]) for h in rule["headers"]]
    return []


class LabHandler(SimpleHTTPRequestHandler):
    """Static files from web/, plus /api/mind. `server` carries `api_key`,
    `forward` and `origins` (the addresses this page is served from)."""

    server_version = "ai-dan-lab"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".jsonl": "application/x-ndjson; charset=utf-8",
        ".svg": "image/svg+xml",
        ".md": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def end_headers(self):
        for key, value in self.server.site_headers:
            self.send_header(key, value)
        self.send_header("Cache-Control", "no-store")   # edits show on reload
        super().end_headers()

    def do_GET(self):
        if not self._from_this_machine():
            return
        if urlsplit(self.path).path == "/api/mind":
            self._json(HTTPStatus.OK, json.dumps({"available": bool(self.server.api_key), "code": False}).encode())
            return
        super().do_GET()

    def do_HEAD(self):
        if self._from_this_machine():
            super().do_HEAD()

    def do_POST(self):
        if not self._from_this_machine():
            return
        if urlsplit(self.path).path != "/api/mind":
            self._json(HTTPStatus.NOT_FOUND, _error("not_found_error", "Nothing here."))
            return
        if not self.server.api_key:
            self._json(HTTPStatus.NOT_FOUND, _error(
                "not_found_error", "There is no ANTHROPIC_API_KEY in .env, so no mind can wake here."))
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, _error("invalid_request_error", "Send JSON."))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_REQUEST_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                       _error("request_too_large", "The conversation is too long for this host."))
            return
        try:
            body = _strict_json(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, _error("invalid_request_error", "The request is not JSON."))
            return
        checked = lab_request(body)
        if isinstance(checked, str):
            self._json(HTTPStatus.BAD_REQUEST, _error("invalid_request_error", checked))
            return
        status, answer = self.server.forward(checked, self.server.api_key)
        self._json(status, answer)
        if status >= 400:
            self.log_message("the model answered %s", status)

    def _from_this_machine(self) -> bool:
        """Only the page served here may use it. A request from another web page
        (its Origin) or through another name for this address (DNS rebinding,
        its Host) could otherwise spend the key."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in self.server.hosts or (origin is not None and origin not in self.server.origins):
            self._json(HTTPStatus.FORBIDDEN, _error("permission_error", "Only this machine's own page may use it."))
            return False
        return True

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def _json(self, status, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quiet for static files; requests that fail still show.
        if args and isinstance(args[0], str) and args[0].startswith(("GET", "HEAD")) and str(args[1])[:1] in "23":
            return
        super().log_message(format, *args)


class _Server(ThreadingHTTPServer):
    daemon_threads = True


class _Server6(_Server):
    address_family = socket.AF_INET6


def make_server(port: int = DEFAULT_PORT, api_key: str | None = None, forward_fn=forward,
                host: str = "127.0.0.1") -> ThreadingHTTPServer:
    """A server on a loopback address only: 127.0.0.1, or ::1."""
    server = (_Server6 if ":" in host else _Server)((host, port), LabHandler)
    port = server.server_address[1]   # the real one, when 0 asked for any
    names = ("localhost", "127.0.0.1", "[::1]")
    server.hosts = {f"{name}:{port}" for name in names}
    server.origins = {f"http://{name}:{port}" for name in names}
    server.api_key = api_key
    server.forward = forward_fn
    server.site_headers = _site_headers()
    return server


def serve(port: int = DEFAULT_PORT, open_browser: bool = True) -> int:
    _load_dotenv()
    api_key = os.environ.get("ANTHROPIC_API_KEY") or None
    try:
        server = make_server(port, api_key)
    except OSError as exc:
        print(f"Port {port} is busy ({exc.strerror}). Try another: uv run main.py --port 8081", flush=True)
        return 1
    port = server.server_address[1]
    # Browsers try localhost's IPv6 address first; answering there too saves a slow fallback.
    try:
        server6 = make_server(port, api_key, host="::1")
        threading.Thread(target=server6.serve_forever, daemon=True).start()
    except OSError:
        server6 = None
    url = f"http://localhost:{port}"
    print(f"The lab is open at {url}   (Ctrl+C to close it)", flush=True)
    if api_key:
        print("A mind can wake: its requests use the ANTHROPIC_API_KEY in .env, from this machine only.", flush=True)
    else:
        print("No ANTHROPIC_API_KEY in .env: replays and the wiring test work, a live mind does not.", flush=True)
    if open_browser:
        threading.Timer(0.6, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nClosed.", flush=True)
    finally:
        server.server_close()
        if server6:
            server6.shutdown()
            server6.server_close()
    return 0
