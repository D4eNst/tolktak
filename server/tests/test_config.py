import pytest
from conftest import make_config
from fastapi.testclient import TestClient

from tolktak.app import create_app
from tolktak.config import ConfigError, from_env

SECRET = "x" * 32


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in [
        "LIVEKIT_PUBLIC_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
        "TOLKTAK_S3_BUCKET", "TOLKTAK_S3_ENDPOINT", "TOLKTAK_S3_REGION", "TOLKTAK_S3_ACCESS_KEY",
        "TOLKTAK_S3_SECRET_KEY",
    ]:  # fmt: skip
        monkeypatch.delenv(k, raising=False)


def with_keys(monkeypatch):
    monkeypatch.setenv("LIVEKIT_API_KEY", "key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", SECRET)


def test_public_url_optional(monkeypatch):
    with_keys(monkeypatch)
    assert from_env().livekit_public_url == ""


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
