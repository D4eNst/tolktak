import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tolktak.app import create_app
from tolktak.config import Config

TEST_SECRET = "test-secret-test-secret-test-secret-0123"
PG_URL = os.environ.get("TOLKTAK_TEST_POSTGRES", "")

DATABASES = ["sqlite"] + (["postgres"] if PG_URL else [])


def _reset_postgres(url: str) -> None:
    import asyncpg

    async def run():
        c = await asyncpg.connect(url)
        try:
            await c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        finally:
            await c.close()

    asyncio.run(run())


@pytest.fixture(params=DATABASES)
def database_url(request, tmp_path: Path) -> str:
    if request.param == "postgres":
        _reset_postgres(PG_URL)
        return PG_URL
    return ""


def make_config(tmp_path: Path, database_url: str = "", registration: str = "open", **kw) -> Config:
    values: dict[str, Any] = dict(
        server_name="Test",
        registration=registration,
        livekit_public_url="ws://lk.test",
        livekit_internal_url="http://127.0.0.1:1",
        livekit_api_key="devkey",
        livekit_api_secret=TEST_SECRET,
        client_download_url="",
        trust_proxy=False,
        data_dir=tmp_path / "data",
        database_url=database_url,
        max_upload_bytes=1 << 20,
        listen_host="127.0.0.1",
        listen_port=0,
        debug=False,
    )
    values.update(kw)
    return Config(**values)


class Env:
    def __init__(self, client: TestClient):
        self.c = client
        self.server = client.app.state.server

    def do(self, method: str, path: str, token: str = "", body=None) -> tuple[int, dict]:
        headers = {"Authorization": "Bearer " + token} if token else {}
        r = self.c.request(method, path, json=body, headers=headers)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {}

    def user(self, name: str, invite: str = "") -> tuple[str, int]:
        code, body = self.do(
            "POST", "/api/v1/auth/register", body={"username": name, "password": "password123", "invite": invite}
        )
        assert code == 201, body
        code, body = self.do("POST", "/api/v1/auth/login", body={"username": name, "password": "password123"})
        assert code == 200, body
        return body["token"], body["user"]["id"]

    def upload(self, token: str, name: str, data: bytes) -> tuple[int, dict]:
        r = self.c.post(
            "/api/v1/files", params={"name": name}, content=data, headers={"Authorization": "Bearer " + token}
        )
        return r.status_code, r.json()


@pytest.fixture
def make_env(tmp_path: Path, database_url: str):
    clients = []

    def make(registration: str = "open", **kw) -> Env:
        client = TestClient(create_app(make_config(tmp_path, database_url, registration, **kw)))
        client.__enter__()
        clients.append(client)
        return Env(client)

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def err_code(body: dict) -> str:
    return body.get("error", {}).get("code", "")


def decode_jwt(tok: str) -> dict:
    part = tok.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def post_webhook(e: Env, body: bytes, secret: str = TEST_SECRET) -> int:
    now = int(time.time())
    claims = {
        "iss": "devkey",
        "nbf": now - 5,
        "exp": now + 60,
        "sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
    }

    def enc(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    unsigned = enc(b'{"alg":"HS256","typ":"JWT"}') + "." + enc(json.dumps(claims).encode())
    sig = enc(hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest())
    r = e.c.post("/api/v1/livekit/webhook", content=body, headers={"Authorization": unsigned + "." + sig})
    return r.status_code
