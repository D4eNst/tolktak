import asyncio

import pytest
from conftest import Env, make_config
from fastapi.testclient import TestClient
from test_history_migration import _v6_database
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.app import create_app
from tolktak.copydb import ORDER
from tolktak.store import search, users


async def seed_v8(cfg):
    await _v6_database(cfg)
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        await db.execute("UPDATE users SET display_name = 'Straße ПрИвЕт a_%b' WHERE id = 1")
        async with in_transaction(db.CONN) as tx:
            await search.backfill(tx)
        token = await users.create_session(1, "before upgrade")
        before = {
            t: await db.rows(f"SELECT * FROM {t} ORDER BY {ORDER.get(t, 'id')}")
            for t in db.TABLES
            if t not in ("contacts", "voice_rules", "contact_links")
        }
        return token, before
    finally:
        await db.close()


def test_v8_user_data_sessions_search_and_history_survive_migration9(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:8])
        m.setattr(db, "POSTGRES", db.POSTGRES[:8])
        token, before = asyncio.run(seed_v8(cfg))
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        assert e.c.portal is not None
        assert e.c.portal.call(db.rows, "SELECT version FROM schema_version") == [{"version": len(db.SQLITE)}]
        for table, old_rows in before.items():
            current = e.c.portal.call(db.rows, f"SELECT * FROM {table} ORDER BY {ORDER.get(table, 'id')}")
            if old_rows:
                assert [{k: row[k] for k in old_rows[0]} for row in current] == old_rows
            else:
                assert current == []
        code, result = e.do("GET", "/api/v1/users/directory?q=STRASSE", token)
        assert code == 200 and [u["id"] for u in result["users"]] == [1]
        assert result["users"][0]["profile_revision"] == 0 and result["contacts_version"] == 1
        assert result["contact_ids"] == []
        assert e.do("GET", "/api/v1/channels/1/history", token)[1]["messages"][0]["text"] == "after"
        assert e.do("GET", "/api/v1/channels/1/search?q=after", token)[1]["messages"][0]["id"] == 1
        assert e.do("PUT", "/api/v1/contacts/2", token)[1]["contacts_version"] == 2
        changed = e.do("PATCH", "/api/v1/me", token, {"status": "survives restart"})[1]["user"]
        assert changed["profile_revision"] == 1
        saved = e.do("GET", "/api/v1/contacts", token)[1]
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        assert e.do("GET", "/api/v1/contacts", token)[1] == saved
        assert e.do("GET", "/api/v1/me", token)[1]["user"] == changed


async def test_failed_directory_backfill_rolls_back_migration9(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:8])
        m.setattr(db, "POSTGRES", db.POSTGRES[:8])
        _, before = await seed_v8(cfg)
    backfill = users.backfill_directory

    async def fail(tx):
        await backfill(tx)
        raise RuntimeError("directory backfill interrupted")

    with monkeypatch.context() as m:
        m.setattr(users, "backfill_directory", fail)
        try:
            with pytest.raises(RuntimeError, match="directory backfill interrupted"):
                await db.init(cfg.database_url, cfg.data_dir)
            assert await db.rows("SELECT version FROM schema_version") == [{"version": 8}]
            assert await db.rows("SELECT * FROM users ORDER BY id") == before["users"]
        finally:
            await db.close()
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        assert await db.rows("SELECT version FROM schema_version") == [{"version": len(db.SQLITE)}]
        assert (await db.rows("SELECT display_name_folded FROM users WHERE id = 1"))[0][
            "display_name_folded"
        ] == "strasse привет a_%b"
    finally:
        await db.close()
