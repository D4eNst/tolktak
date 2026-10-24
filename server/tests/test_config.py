import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from conftest import TEST_SECRET, make_config
from fastapi.testclient import TestClient

from tolktak.__main__ import serve
from tolktak.app import create_app
from tolktak.config import ConfigError, from_env
from tolktak.livekit_process import livekit_config, load_keys

# File modes and the fake livekit-server, a shell script, need a POSIX system.
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX only")

SECRET = "x" * 32


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in [
        "LIVEKIT_PUBLIC_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "TOLKTAK_EMBEDDED_LIVEKIT",
        "TOLKTAK_S3_BUCKET", "TOLKTAK_S3_ENDPOINT", "TOLKTAK_S3_REGION", "TOLKTAK_S3_ACCESS_KEY",
        "TOLKTAK_S3_SECRET_KEY", "NODE_IP",
    ]:  # fmt: skip
        monkeypatch.delenv(k, raising=False)


def with_keys(monkeypatch):
    monkeypatch.setenv("LIVEKIT_API_KEY", "key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", SECRET)


def test_public_url_optional(monkeypatch):
    with_keys(monkeypatch)
    assert from_env().livekit_public_url == ""


def test_embedded_skips_livekit_keys(monkeypatch):
    monkeypatch.setenv("TOLKTAK_EMBEDDED_LIVEKIT", "1")
    assert from_env().embedded_livekit is True


def test_keys_required_without_embedded():
    with pytest.raises(ConfigError):
        from_env()


def test_s3_needs_keys(monkeypatch):
    with_keys(monkeypatch)
    monkeypatch.setenv("TOLKTAK_S3_BUCKET", "files")
    with pytest.raises(ConfigError):
        from_env()


def test_s3_fields(monkeypatch):
    with_keys(monkeypatch)
    monkeypatch.setenv("TOLKTAK_S3_BUCKET", "files")
    monkeypatch.setenv("TOLKTAK_S3_ENDPOINT", "http://garage:3900")
    monkeypatch.setenv("TOLKTAK_S3_REGION", "garage")
    monkeypatch.setenv("TOLKTAK_S3_ACCESS_KEY", "GK1")
    monkeypatch.setenv("TOLKTAK_S3_SECRET_KEY", "s3secret")
    cfg = from_env()
    assert (cfg.s3_bucket, cfg.s3_endpoint, cfg.s3_region, cfg.s3_access_key, cfg.s3_secret_key) == (
        "files", "http://garage:3900", "garage", "GK1", "s3secret",
    )  # fmt: skip


@pytest.mark.parametrize(
    "trust_proxy, headers, url",
    [
        (False, {"Host": "203.0.113.10:8080"}, "ws://203.0.113.10:7880"),
        (False, {"Host": "[2001:db8::1]:8080"}, "ws://[2001:db8::1]:7880"),
        (True, {"Host": "chat.example.com", "X-Forwarded-Proto": "https"}, "wss://chat.example.com"),
        (True, {"Host": "127.0.0.1:8080", "X-Forwarded-Host": "chat.example.com", "X-Forwarded-Proto": "https"},
         "wss://chat.example.com"),
        (False, {"Host": "chat.example.com", "X-Forwarded-Proto": "https"}, "ws://chat.example.com:7880"),
    ],
)  # fmt: skip
def test_livekit_url_from_request(tmp_path, trust_proxy, headers, url):
    cfg = make_config(tmp_path, livekit_public_url="", trust_proxy=trust_proxy)
    with TestClient(create_app(cfg)) as c:
        assert c.get("/api/v1/server", headers=headers).json()["livekit_url"] == url
        c.post("/api/v1/auth/register", json={"username": "alice", "password": "password123"})
        token = c.post("/api/v1/auth/login", json={"username": "alice", "password": "password123"}).json()["token"]
        auth = {"Authorization": "Bearer " + token}
        group = c.post("/api/v1/groups", json={"name": "g"}, headers=auth).json()["group"]
        r = c.post("/api/v1/voice/join", json={"room_id": group["rooms"][0]["id"]}, headers=auth | headers)
        assert r.json()["url"] == url


def test_livekit_url_configured(tmp_path):
    cfg = make_config(tmp_path, livekit_public_url="wss://lk.example.com")
    with TestClient(create_app(cfg)) as c:
        assert c.get("/api/v1/server", headers={"Host": "chat.example.com"}).json()["livekit_url"] == (
            "wss://lk.example.com"
        )


@posix_only
def test_load_keys_persist(tmp_path):
    key, secret = load_keys(tmp_path)
    path = tmp_path / "livekit-keys"
    assert path.stat().st_mode & 0o777 == 0o600
    assert key.startswith("tk") and len(secret) == 64
    mtime = path.stat().st_mtime_ns
    assert load_keys(tmp_path) == (key, secret)
    assert path.stat().st_mtime_ns == mtime


@pytest.mark.parametrize(
    "host, webhook",
    [
        ("0.0.0.0", "http://127.0.0.1:18480/api/v1/livekit/webhook"),
        ("10.0.0.5", "http://10.0.0.5:18480/api/v1/livekit/webhook"),
        ("::1", "http://[::1]:18480/api/v1/livekit/webhook"),
    ],
)
def test_livekit_config(tmp_path, host, webhook):
    c = livekit_config(make_config(tmp_path, listen_host=host, listen_port=18480))
    assert c["webhook"] == {"api_key": "devkey", "urls": [webhook]}
    assert c["keys"] == {"devkey": TEST_SECRET}
    assert c["port"] == 7880 and c["rtc"]["tcp_port"] == 7881 and c["rtc"]["udp_port"] == 7882
    assert c["turn"]["enabled"] is False
    h264 = next(codec for codec in c["room"]["enabled_codecs"] if codec["mime"] == "video/H264")
    assert "profile-level-id=42001f" in h264["fmtp_line"]


def test_node_ip_turns_off_stun(tmp_path, monkeypatch):
    assert livekit_config(make_config(tmp_path))["rtc"]["use_external_ip"] is True
    monkeypatch.setenv("NODE_IP", "192.168.1.20")
    assert livekit_config(make_config(tmp_path))["rtc"]["use_external_ip"] is False


@posix_only
def test_serve_exits_when_livekit_dies(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "livekit-server"
    fake.write_text("#!/bin/sh\nexit 3\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("TOLKTAK_EMBEDDED_LIVEKIT", "1")
    monkeypatch.setenv("TOLKTAK_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TOLKTAK_LISTEN", "127.0.0.1:0")
    assert serve() == 1


def test_load_keys_replaces_empty_file(tmp_path):
    (tmp_path / "livekit-keys").write_text("")
    key, secret = load_keys(tmp_path)
    assert key.startswith("tk") and len(secret) == 64
    assert load_keys(tmp_path) == (key, secret)


def start_server(tmp_path, port: int) -> tuple[subprocess.Popen, Path]:
    """Runs serve() in a child process with a fake livekit-server that records its pid and sleeps."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pidfile = tmp_path / "livekit.pid"
    fake = bin_dir / "livekit-server"
    fake.write_text(f"#!/bin/sh\necho $$ > {pidfile}\nexec sleep 60\n")
    fake.chmod(0o755)
    env = {
        **os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "TOLKTAK_EMBEDDED_LIVEKIT": "1",
        "TOLKTAK_DATA_DIR": str(tmp_path / "data"), "TOLKTAK_LISTEN": f"127.0.0.1:{port}",
    }  # fmt: skip
    code = "from tolktak.__main__ import serve; raise SystemExit(serve())"
    proc = subprocess.Popen(
        [sys.executable, "-c", code], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    for _ in range(100):
        if pidfile.exists() and pidfile.read_text().strip():
            break
        time.sleep(0.05)
    return proc, pidfile


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@posix_only
def test_sigterm_stops_livekit(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc, pidfile = start_server(tmp_path, port)
    pid = int(pidfile.read_text())
    try:
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        proc.wait(15)
        time.sleep(0.2)
        assert not alive(pid)
    finally:
        if alive(pid):
            os.kill(pid, signal.SIGKILL)


@posix_only
def test_busy_port_does_not_blame_livekit(tmp_path):
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        proc, _ = start_server(tmp_path, busy.getsockname()[1])
        out, _ = proc.communicate(timeout=15)
    assert proc.returncode != 0
    assert "address already in use" in out.lower()
    assert "livekit-server exited" not in out
