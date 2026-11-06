import asyncio
import json

import pytest
from conftest import Env, make_config
from fastapi.testclient import TestClient
from test_history_migration import _login, _v6_database
from test_search import page
from tortoise.exceptions import OperationalError

from tolktak import db
from tolktak.app import create_app
from tolktak.store import chat, search


async def _v7_database(cfg):
    await _v6_database(cfg)
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        await db.execute("UPDATE messages SET text = 'ПрИвЕт Straße a_%b edited', revision = 3 WHERE id = 1")
        await db.execute(
            "INSERT INTO messages (channel_id, author_id, nonce, text, created_at, reply_to, revision, pinned_at) "
            "VALUES (1, 2, 'reply', 'reply :: original', 3, 1, 5, 4)"
        )
        await db.execute("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (2, 1, '👍', 4)")
        await db.execute(
            "INSERT INTO messages (channel_id, author_id, nonce, text, created_at, revision, deleted) "
            "VALUES (1, 1, 'deleted', 'deleted legacy secret', 5, 6, 1)"
        )
        await db.execute("UPDATE channels SET history_version = 6 WHERE id = 1")
        await db.execute("UPDATE channel_members SET last_read_id = 2 WHERE user_id = 2")
        tables = [
            t
            for t in db.TABLES
            if not t.startswith("message_search")
            and t not in ("sessions", "users", "contacts", "voice_rules", "contact_links")
        ]
        preserved = {t: await db.rows(f"SELECT * FROM {t}") for t in tables}
        return await chat.messages_by_ids([1, 2]), preserved
    finally:
        await db.close()


def test_v7_search_backfill_preserves_all_original_data_and_restarts(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:7])
        m.setattr(db, "POSTGRES", db.POSTGRES[:7])
        messages, preserved = asyncio.run(_v7_database(cfg))
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        bob, _ = _login(e, "bob")
        assert e.c.portal is not None
        assert e.c.portal.call(db.rows, "SELECT version FROM schema_version") == [{"version": len(db.SQLITE)}]
        for table, data in preserved.items():
            assert e.c.portal.call(db.rows, f"SELECT * FROM {table}") == data
        snapshot = e.do("GET", "/api/v1/channels/1/history", bob)[1]
        assert snapshot["messages"] == messages
        assert snapshot["history_version"] == 6 and snapshot["read"] == {"message_id": 2, "unread": 0}
        for query in ("привет", "STRASSE", "a_%b"):
            assert [m["id"] for m in page(e, bob, 1, query)["messages"]] == [1]
        assert page(e, bob, 1, "deleted legacy secret")["messages"] == []
        assert [
            r["message_id"]
            for r in e.c.portal.call(db.rows, "SELECT message_id FROM message_search ORDER BY message_id")
        ] == [1, 2]
        saved = json.dumps(page(e, bob, 1, "::"), sort_keys=True)
        indexed_count = e.c.portal.call(db.rows, "SELECT COUNT(*) AS n FROM message_search")
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        assert e.c.portal is not None
        assert json.dumps(page(e, bob, 1, "::"), sort_keys=True) == saved
        assert e.c.portal.call(db.rows, "SELECT COUNT(*) AS n FROM message_search") == indexed_count


async def test_failed_native_index_migration_rolls_back_schema8(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:7])
        m.setattr(db, "POSTGRES", db.POSTGRES[:7])
        await db.init(cfg.database_url, cfg.data_dir)
        await db.close()
    initialize = search.init_index

    async def fail(tx):
        await initialize(tx)
        raise RuntimeError("native index initialization failed")

    with monkeypatch.context() as m:
        m.setattr(search, "init_index", fail)
        try:
            with pytest.raises(RuntimeError, match="native index initialization failed"):
                await db.init(cfg.database_url, cfg.data_dir)
            assert await db.rows("SELECT version FROM schema_version") == [{"version": 7}]
            query = (
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
                "AND table_name = 'message_search'"
                if database_url
                else "SELECT name FROM sqlite_master WHERE name LIKE 'message_search%'"
            )
            assert await db.rows(query) == []
        finally:
            await db.close()
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        assert await db.rows("SELECT version FROM schema_version") == [{"version": len(db.SQLITE)}]
    finally:
        await db.close()


@pytest.mark.parametrize("unsupported", ["missing", "3.33.0"])
async def test_unsupported_sqlite_search_reports_a_descriptive_error(tmp_path, monkeypatch, unsupported):
    cfg = make_config(tmp_path)
    try:
        await db.init("", cfg.data_dir)
        rows = db.rows

        async def simulate(query, values=None, c=None):
            if "fts5_source_id" in query:
                if unsupported == "missing":
                    raise OperationalError("no such function: fts5_source_id")
                return [{"version": unsupported, "fts": "test"}]
            return await rows(query, values, c)

        monkeypatch.setattr(db, "rows", simulate)
        with pytest.raises(RuntimeError, match="SQLite 3.34.*FTS5.*trigram"):
            await search.check_features(db.conn())
    finally:
        await db.close()
