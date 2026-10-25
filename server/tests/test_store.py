import asyncio
import contextlib
import json
import sqlite3

import pytest
from conftest import PG_URL, _reset_postgres, make_config
from fastapi.testclient import TestClient

from tolktak import db, sqlite_backend
from tolktak.app import create_app
from tolktak.copydb import copy
from tolktak.store import users

# Hashes written by the 0.1 Go server for "password1".
GO_HASH = "argon2id$3$65536$2$jemqnL6RqWZdywksRUFY6w$Ll+or2v/nAhfkHS5lTGcpZn7MBLo5IYUh/sjF52ypys"


def test_password_hash_format_matches_earlier_versions():
    assert asyncio.run(users.check_password(GO_HASH, "password1"))
    assert not asyncio.run(users.check_password(GO_HASH, "password2"))
    h = asyncio.run(users.hash_password("password1"))
    assert h.startswith("argon2id$3$65536$2$") and len(h.split("$")) == 6
    assert asyncio.run(users.check_password(h, "password1"))


def _old_database(path):
    con = sqlite3.connect(path)
    for script in db.SQLITE[:2]:
        con.executescript(script)
    con.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    con.execute("INSERT INTO schema_version VALUES (2)")
    con.execute(
        "INSERT INTO users (username, display_name, password_hash, color, is_admin, created_at) "
        "VALUES ('alice', 'Alice', ?, '#e5484d', 1, 1)",
        [GO_HASH],
    )
    con.execute("INSERT INTO channels (kind, dm_key, created_at) VALUES ('group', NULL, 1)")
    con.execute("INSERT INTO groups (name, owner_id, channel_id, created_at) VALUES ('G', 1, 1, 1)")
    con.execute("INSERT INTO group_members (group_id, user_id, joined_at, role) VALUES (1, 1, 1, 'member')")
    con.execute("INSERT INTO channel_members (channel_id, user_id) VALUES (1, 1)")
    con.execute("INSERT INTO rooms (group_id, name, position, created_at) VALUES (1, 'General', 0, 1)")
    con.execute(
        "INSERT INTO text_channels (channel_id, group_id, name, position, created_at) VALUES (1, 1, 'general', 0, 1)"
    )
    con.execute(
        "INSERT INTO messages (channel_id, author_id, nonce, text, created_at) VALUES (1, 1, 'n', 'old message', 1)"
    )
    con.commit()
    con.close()


def test_opens_database_from_earlier_version(tmp_path):
    cfg = make_config(tmp_path)
    cfg.data_dir.mkdir(parents=True)
    _old_database(cfg.data_dir / "tolktak.db")
    with TestClient(create_app(cfg)) as c:
        r = c.post("/api/v1/auth/login", json={"username": "alice", "password": "password1"})
        assert r.status_code == 200, r.text
        tok = {"Authorization": "Bearer " + r.json()["token"]}
        msgs = c.get("/api/v1/channels/1/messages", headers=tok).json()["messages"]
        assert [m["text"] for m in msgs] == ["old message"]
        r = c.post("/api/v1/channels/1/messages", headers=tok, json={"text": "new", "nonce": "n2"})
        assert r.status_code == 200
        # Tables were rebuilt with AUTOINCREMENT, keeping their indexes.
        con = sqlite3.connect(cfg.data_dir / "tolktak.db")
        schema = dict(con.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'").fetchall())
        indexes = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        con.close()
        for t in db.AUTOINCREMENT_TABLES:
            assert "AUTOINCREMENT" in schema[t]
        assert {"messages_channel", "text_channels_group"} <= indexes


async def _schema_4_database(cfg, files: list[str], attachments: str) -> None:
    await db.init(cfg.database_url, cfg.data_dir)
    try:
        for q, values in (
            (
                "INSERT INTO users (username, display_name, password_hash, color, created_at) "
                "VALUES ('alice', 'Alice', ?, '#e5484d', 1)",
                [GO_HASH],
            ),
            ("INSERT INTO channels (kind, created_at) VALUES ('group', 1)", []),
            ("INSERT INTO channel_members (channel_id, user_id) VALUES (1, 1)", []),
            (
                "INSERT INTO files (id, uploader_id, name, mime, size, created_at) "
                "VALUES (?, 1, 'a.png', 'image/png', 1, 1), (?, 1, 'b.png', 'image/png', 1, 1)",
                files,
            ),
            (
                "INSERT INTO messages (channel_id, author_id, nonce, text, created_at, deleted, attachments) "
                "VALUES (1, 1, 'n1', '', 1, 0, ?), (1, 1, 'n2', 'text', 2, 0, ''), (1, 1, 'n3', '', 3, 1, ?)",
                [attachments, attachments],
            ),
        ):
            await db.execute(q, values)
    finally:
        await db.close()


def test_attachments_move_to_their_own_table(tmp_path, database_url, make_env, monkeypatch):
    first, second = "a" * 32, "b" * 32
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:4])
        m.setattr(db, "POSTGRES", db.POSTGRES[:4])
        asyncio.run(_schema_4_database(make_config(tmp_path, database_url), [first, second], f"{second},{first}"))
    e = make_env()
    tok = e.do("POST", "/api/v1/auth/login", body={"username": "alice", "password": "password1"})[1]["token"]
    _, body = e.do("GET", "/api/v1/channels/1/messages", tok)
    assert [[f["id"] for f in m["attachments"]] for m in body["messages"]] == [[second, first], [], []]
    assert "attachments" not in e.c.portal.call(db.rows, "SELECT * FROM messages")[0]
    _, body = e.do("POST", "/api/v1/channels/1/messages", tok, {"nonce": "n4", "attachments": [second, first]})
    assert [f["id"] for f in body["message"]["attachments"]] == [second, first]


def test_refuses_newer_schema(tmp_path):
    path = tmp_path / "tolktak.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    con.execute("INSERT INTO schema_version VALUES (99)")
    con.commit()
    con.close()
    with pytest.raises(Exception, match="newer"):
        asyncio.run(_init_close(f"sqlite://{path}", tmp_path))


def test_checkpoint_loop_outlives_unexpected_errors(tmp_path, monkeypatch):
    calls = []

    def checkpoint(path):
        calls.append(path)
        raise RuntimeError("unexpected")

    monkeypatch.setattr(sqlite_backend, "_checkpoint", checkpoint)

    async def run():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(sqlite_backend.checkpoint_loop(tmp_path / "x.db", 0), 0.1)

    asyncio.run(run())
    assert len(calls) > 1


def test_shutdown_outlives_a_failed_background_task(tmp_path, monkeypatch):
    async def checkpoint_loop(_):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(sqlite_backend, "checkpoint_loop", checkpoint_loop)
    with TestClient(create_app(make_config(tmp_path))) as c:
        assert c.get("/healthz").text == "ok"


async def _init_close(url, data_dir):
    try:
        await db.init(url, data_dir)
    finally:
        await db.close()


def _fill(cfg) -> None:
    with TestClient(create_app(cfg)) as c:
        c.post("/api/v1/auth/register", json={"username": "alice", "password": "password1"})
        c.post("/api/v1/auth/register", json={"username": "bob", "password": "password1"})
        tok = {"Authorization": "Bearer " + c.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "password1"}
        ).json()["token"]}  # fmt: skip
        dm = c.post("/api/v1/dms", headers=tok, json={"user_id": 2}).json()["channel"]["id"]
        g = c.post("/api/v1/groups", headers=tok, json={"name": "G", "members": [2]}).json()["group"]
        for i in range(3):
            m = c.post(f"/api/v1/channels/{dm}/messages", headers=tok, json={"text": f"m{i}", "nonce": f"n{i}"})
            c.post(f"/api/v1/messages/{m.json()['message']['id']}/reactions", headers=tok, json={"emoji": "👍"})
        c.post(f"/api/v1/channels/{g['channel_id']}/messages", headers=tok, json={"text": "g", "nonce": "g"})


def _snapshot(cfg, create: bool = False) -> tuple[str, str]:
    with TestClient(create_app(cfg)) as c:
        tok = {"Authorization": "Bearer " + c.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "password1"}
        ).json()["token"]}  # fmt: skip
        chans = c.get("/api/v1/channels", headers=tok).json()
        groups = c.get("/api/v1/groups", headers=tok).json()
        if create:
            # New rows continue after the copied ones.
            r = c.post("/api/v1/groups", headers=tok, json={"name": "after copy"})
            assert r.status_code == 201, r.text
        return json.dumps(chans, sort_keys=True), json.dumps(groups, sort_keys=True)


@pytest.mark.parametrize("target", ["sqlite"] + (["postgres"] if PG_URL else []))
def test_copy_db(tmp_path, target):
    src = make_config(tmp_path / "a")
    _fill(src)
    if target == "postgres":
        _reset_postgres(PG_URL)
        dst_url = PG_URL
    else:
        dst_url = f"sqlite://{tmp_path / 'b.db'}"
    src_url = f"sqlite://{src.data_dir / 'tolktak.db'}"
    before = _snapshot(src)
    assert asyncio.run(copy(src_url, dst_url)) == 0
    # A second copy into a non-empty database is refused.
    assert asyncio.run(copy(src_url, dst_url)) == 1
    dst = make_config(tmp_path / "a", database_url=dst_url)
    after = _snapshot(dst, create=True)
    assert json.loads(after[0]) == json.loads(before[0])
    assert json.loads(after[1]) == json.loads(before[1])
