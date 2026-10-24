import json

from tolktak.updates import MIN_CLIENT_VERSION, parse_version


def test_parse_version():
    assert parse_version("0.1.5") == (0, 1, 5)
    assert parse_version("v1.2.3") == (1, 2, 3)
    for v in ("0.1.0-dev", "", "1.2", "1.2.3.4"):
        assert parse_version(v) is None, v


def test_server_info_reports_min_client(make_env):
    e = make_env()
    code, body = e.do("GET", "/api/v1/server")
    assert code == 200
    assert body["min_client"] == MIN_CLIENT_VERSION


def test_hello_reports_min_client(make_env):
    e = make_env()
    token, _ = e.user("alice")
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        hello = json.loads(ws.receive_text())
    assert hello["type"] == "hello"
    assert hello["data"]["server"]["min_client"] == MIN_CLIENT_VERSION
