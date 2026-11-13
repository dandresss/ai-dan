"""The local web lab (`uv run main.py`): the twin of web/api/mind.js, and the
server that hands the page to the browser."""
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from lab import web
from lab.__main__ import main

CASES = Path(__file__).resolve().parent.parent / "web" / "tests" / "fixtures" / "proxy_cases.json"
KEY = "sk-test-local-key"


@pytest.mark.parametrize("case", json.loads(CASES.read_text(encoding="utf-8")), ids=lambda c: c["name"])
def test_same_answers_as_the_vercel_function(case):
    assert web.lab_request(case["request"]) == case["answer"]


@pytest.fixture
def lab_server():
    """A server on a free port, with a stand-in for the Messages API."""
    sent = []

    def fake_forward(request, api_key):
        sent.append((request, api_key))
        return 200, json.dumps({"content": [], "stop_reason": "end_turn"}).encode()

    def start(api_key=KEY):
        server = web.make_server(0, api_key, fake_forward)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}", sent

    servers = []
    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def call(url, data=None, headers=None, method=None):
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def lab_body():
    return json.loads(CASES.read_text(encoding="utf-8"))[0]["request"]   # "first day, one wake"


def test_serves_the_page_with_the_deploy_headers(lab_server):
    base, _ = lab_server()
    status, headers, page = call(base + "/")
    assert status == 200 and b"A body to wake up in" in page
    deploy = json.loads((web.WEB_DIR / "vercel.json").read_text(encoding="utf-8"))["headers"][0]["headers"]
    for header in deploy:
        assert headers[header["key"]] == header["value"]
    assert "api.anthropic.com" not in headers["Content-Security-Policy"]   # the page talks only to its host
    status, headers, _ = call(base + "/lab/app.js")
    assert status == 200 and headers["Content-Type"].startswith("text/javascript")
    status, _, log = call(base + "/sessions/first-wake.jsonl")
    assert status == 200 and log.startswith(b'{"type": "header"')
    assert call(base + "/lab/")[0] == 404          # no directory listings


def test_says_a_mind_can_wake_without_a_code(lab_server):
    base, _ = lab_server()
    assert json.loads(call(base + "/api/mind")[2]) == {"available": True, "code": False}
    base, _ = lab_server(api_key=None)
    assert json.loads(call(base + "/api/mind")[2]) == {"available": False, "code": False}


def test_forwards_a_lab_request_with_the_key(lab_server):
    base, sent = lab_server()
    status, _, answer = call(base + "/api/mind", json.dumps(lab_body()).encode(),
                             {"Content-Type": "application/json", "Origin": base})
    assert status == 200 and json.loads(answer)["stop_reason"] == "end_turn"
    assert sent == [(web.lab_request(lab_body()), KEY)]
    assert KEY.encode() not in answer


def test_refuses_what_is_not_the_lab(lab_server):
    base, sent = lab_server()
    json_headers = {"Content-Type": "application/json"}
    other = dict(lab_body(), system="You are a helpful assistant.")
    assert call(base + "/api/mind", json.dumps(other).encode(), json_headers)[0] == 400
    assert call(base + "/api/mind", b"{not json", json_headers)[0] == 400
    assert call(base + "/api/mind", json.dumps(lab_body()).encode(), {"Content-Type": "text/plain"})[0] == 415
    assert sent == []


def test_refuses_other_web_pages_and_other_names(lab_server):
    base, sent = lab_server()
    body = json.dumps(lab_body()).encode()
    evil = {"Content-Type": "application/json", "Origin": "https://evil.example"}
    assert call(base + "/api/mind", body, evil)[0] == 403
    port = base.rsplit(":", 1)[1]
    rebound = {"Content-Type": "application/json", "Host": f"evil.example:{port}"}
    assert call(base + "/api/mind", body, rebound)[0] == 403
    assert call(base + "/api/mind", headers={"Host": f"evil.example:{port}"})[0] == 403
    assert sent == []


def test_no_key_no_mind(lab_server):
    base, sent = lab_server(api_key=None)
    status, _, answer = call(base + "/api/mind", json.dumps(lab_body()).encode(), {"Content-Type": "application/json"})
    assert status == 404 and b".env" in answer
    assert sent == []


def test_the_api_errors_pass_through(lab_server, monkeypatch):
    server = web.make_server(0, KEY, lambda request, key: (529, b'{"type": "error", "error": {"message": "Overloaded"}}'))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        status, _, answer = call(base + "/api/mind", json.dumps(lab_body()).encode(), {"Content-Type": "application/json"})
        assert status == 529 and json.loads(answer)["error"]["message"] == "Overloaded"
    finally:
        server.shutdown()
        server.server_close()


def test_main_opens_the_web_page_by_default(monkeypatch):
    seen = []
    monkeypatch.setattr(web, "serve", lambda port, open_browser=True: seen.append((port, open_browser)) or 0)
    assert main([]) == 0
    assert main(["--port", "9000", "--no-browser"]) == 0
    assert seen == [(8080, True), (9000, False)]


def test_desktop_options_need_the_desktop(capsys):
    with pytest.raises(SystemExit):
        main(["--memory"])
    assert "--desktop" in capsys.readouterr().err


def test_localhost_answers_on_ipv6_too():
    """Browsers try ::1 first for localhost; serve() answers there as well."""
    try:
        server = web.make_server(0, KEY, host="::1")
    except OSError:
        pytest.skip("no IPv6 loopback here")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_address[1]
        status, _, answer = call(f"http://[::1]:{port}/api/mind")
        assert status == 200 and json.loads(answer)["available"] is True
    finally:
        server.shutdown()
        server.server_close()
