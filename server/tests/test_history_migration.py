import asyncio

from conftest import Env, make_config
from fastapi.testclient import TestClient

from tolktak import db
from tolktak.app import create_app
from tolktak.store import chat, users


async def _v5_database(cfg):
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        assert await db.rows("SELECT version FROM schema_version") == [{"version": 5}]
        password_hash = await users.hash_password("password123")
        for query, values in (
            (
                "INSERT INTO users (username, display_name, password_hash, color, is_admin, created_at) "
                "VALUES ('alice', 'Alice', ?, '#e5484d', 1, 1), "
                "('bob', 'Bob', ?, '#e5484d', 0, 1), ('carol', 'Carol', ?, '#e5484d', 0, 1)",
                [password_hash, password_hash, password_hash],
            ),
            (
                "INSERT INTO channels (kind, dm_key, created_at) VALUES ('dm', '1:2', 1), ('dm', '1:3', 1)",
                [],
            ),
            (
                "INSERT INTO messages (channel_id, author_id, nonce, text, created_at, edited_at, reply_to) "
                "VALUES (1, 2, 'legacy-original', 'Before upgrade', 1, NULL, NULL), "
                "(2, 3, 'legacy-foreign', 'Other channel', 2, NULL, NULL), "
                "(1, 2, 'legacy-reply', 'A reply survives', 3, 4, 1)",
                [],
            ),
            (
                "INSERT INTO channel_members (channel_id, user_id, last_read_id) "
                "VALUES (1, 1, 2), (1, 2, 3), (2, 1, 2), (2, 3, 0)",
                [],
            ),
            (
                "INSERT INTO files (id, uploader_id, name, mime, size, width, height, created_at) "
                "VALUES (?, 2, 'image.png', 'image/png', 12, 16, 8, 1), "
                "(?, 2, 'note.txt', 'text/plain', 5, 0, 0, 1)",
                ["a" * 32, "b" * 32],
            ),
            (
                "INSERT INTO message_files (message_id, file_id, position) VALUES (3, ?, 0), (3, ?, 1)",
                ["b" * 32, "a" * 32],
            ),
        ):
            await db.execute(query, values)
    finally:
        await db.close()


def _login(e, name):
    code, body = e.do("POST", "/api/v1/auth/login", body={"username": name, "password": "password123"})
    assert code == 200, body
    assert body["user"]["username"] == name
    return body["token"], body["user"]["id"]


def _get(e, path, token):
    code, body = e.do("GET", path, token)
    assert code == 200, body
    return body


def test_v5_history_and_read_state_survive_upgrade_and_restart(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    # Both dialects' first five migrations were verified identical to HEAD 0575037
    # before adding this regression. Restore the full list before real app startup.
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:5])
        m.setattr(db, "POSTGRES", db.POSTGRES[:5])
        asyncio.run(_v5_database(cfg))

    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        alice, alice_id = _login(e, "alice")
        bob, bob_id = _login(e, "bob")
        assert (alice_id, bob_id) == (1, 2)

        page = _get(e, "/api/v1/channels/1/history", alice)
        assert [m["id"] for m in page["messages"]] == [1, 3]
        assert [m["text"] for m in page["messages"]] == ["Before upgrade", "A reply survives"]
        assert [m["author_id"] for m in page["messages"]] == [2, 2]
        assert [m["nonce"] for m in page["messages"]] == ["legacy-original", "legacy-reply"]
        assert [m["created_at"] for m in page["messages"]] == [1, 3]
        assert [m["revision"] for m in page["messages"]] == [0, 0]
        assert page["history_version"] == 0
        assert (page["first_id"], page["last_id"]) == (1, 3)
        assert page["has_before"] is False and page["has_after"] is False
        original, reply = page["messages"]
        assert original["reply_to"] is None and original["attachments"] == []
        assert reply["edited_at"] == 4 and reply["reply_to"] == 1
        assert reply["reply"] == {
            "id": 1,
            "author_id": 2,
            "text": "Before upgrade",
            "deleted": False,
            "attachments": 0,
            "revision": 0,
        }
        assert reply["attachments"] == [
            {"id": "b" * 32, "name": "note.txt", "mime": "text/plain", "size": 5},
            {"id": "a" * 32, "name": "image.png", "mime": "image/png", "size": 12, "width": 16, "height": 8},
        ]

        # Alice's legacy cursor 2 belongs to another channel: clamp it to 1,
        # leaving the later message 3 unread instead of carrying a foreign cursor.
        assert page["read"] == {"message_id": 1, "unread": 1}
        assert _get(e, "/api/v1/channels/1/read", alice) == {
            "channel_id": 1,
            "message_id": 1,
            "unread": 1,
            "history_version": 0,
        }
        assert _get(e, "/api/v1/channels/1/read", bob) == {
            "channel_id": 1,
            "message_id": 3,
            "unread": 0,
            "history_version": 0,
        }
        foreign = _get(e, "/api/v1/channels/2/history", alice)
        assert [m["id"] for m in foreign["messages"]] == [2]
        assert foreign["messages"][0]["text"] == "Other channel"
        assert foreign["messages"][0]["revision"] == foreign["history_version"] == 0
        assert foreign["read"] == {"message_id": 2, "unread": 0}
        after_cursor = _get(e, "/api/v1/channels/1/history?after=1", alice)
        assert [m["id"] for m in after_cursor["messages"]] == [3]
        summaries = _get(e, "/api/v1/channels", alice)["channels"]
        assert {c["id"]: (c["history_version"], c["last_read_id"], c["unread"]) for c in summaries} == {
            1: (0, 1, 1),
            2: (0, 2, 0),
        }

        code, body = e.do(
            "POST", "/api/v1/channels/1/messages", bob, {"text": "After upgrade", "nonce": "after-upgrade"}
        )
        assert code == 200, body
        new = body["message"]
        assert new["id"] > 3 and new["revision"] == 1
        saved_history = _get(e, "/api/v1/channels/1/history", alice)
        assert [m["id"] for m in saved_history["messages"]] == [1, 3, new["id"]]
        assert [m["revision"] for m in saved_history["messages"]] == [0, 0, 1]
        assert saved_history["history_version"] == 1
        assert saved_history["read"] == {"message_id": 1, "unread": 2}
        saved_read = _get(e, "/api/v1/channels/1/read", bob)
        saved_channels = _get(e, "/api/v1/channels", alice)

    # A second startup must neither reapply migration 6 nor reset revisions/cursors.
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        alice, _ = _login(e, "alice")
        bob, _ = _login(e, "bob")
        assert _get(e, "/api/v1/channels/1/history", alice) == saved_history
        assert _get(e, "/api/v1/channels/1/read", bob) == saved_read
        assert _get(e, "/api/v1/channels", alice) == saved_channels


async def _v6_database(cfg):
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        password = await users.hash_password("password123")
        for query, values in (
            (
                "INSERT INTO users (username, display_name, password_hash, color, created_at) "
                "VALUES ('alice', 'Alice', ?, '#000000', 1), ('bob', 'Bob', ?, '#000000', 1)",
                [password, password],
            ),
            ("INSERT INTO channels (kind, dm_key, created_at, history_version) VALUES ('dm', '1:2', 1, 2)", []),
            ("INSERT INTO channel_members (channel_id, user_id, last_read_id) VALUES (1, 1, 0), (1, 2, 1)", []),
            (
                "INSERT INTO files (id, uploader_id, name, mime, size, created_at) VALUES (?, 1, 'note.txt', 'text/plain', 10, 1)",
                ["a" * 32],
            ),
            (
                "INSERT INTO messages (channel_id, author_id, nonce, text, created_at, edited_at, revision) "
                "VALUES (1, 1, 'keep', 'after', 1, 2, 2)",
                [],
            ),
            ("INSERT INTO message_files (message_id, file_id, position) VALUES (1, ?, 0)", ["a" * 32]),
        ):
            await db.execute(query, values)
        return await chat.message_by_id(1)
    finally:
        await db.close()


def test_v6_revision_data_survives_changes_index_migration(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:6])
        m.setattr(db, "POSTGRES", db.POSTGRES[:6])
        message = asyncio.run(_v6_database(cfg))
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        bob, _ = _login(e, "bob")
        assert e.c.portal is not None
        assert e.c.portal.call(db.rows, "SELECT version FROM schema_version") == [{"version": len(db.SQLITE)}]
        history = _get(e, "/api/v1/channels/1/history", bob)
        assert history["messages"] == [message]
        assert history["history_version"] == 2
        assert history["read"] == {"message_id": 1, "unread": 0}
        assert history["users"][0]["profile_revision"] == 0
        changes = _get(e, "/api/v1/channels/1/changes?since=0", bob)
        assert changes["messages"] == history["messages"]
        assert changes["read"] == history["read"]
        query = (
            "SELECT indexname AS name FROM pg_indexes WHERE indexname = 'messages_channel_revision'"
            if database_url
            else "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_revision'"
        )
        assert e.c.portal.call(db.rows, query) == [{"name": "messages_channel_revision"}]
