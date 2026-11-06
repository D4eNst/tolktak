import asyncio
from uuid import UUID

import pytest
from conftest import Env, make_config
from fastapi.testclient import TestClient

from tolktak import db
from tolktak.app import create_app
from tolktak.models import User
from tolktak.store import users


async def seed_v10(cfg):
    await db.init(cfg.database_url, cfg.data_dir)
    try:
        for uid, version in ((1, 0), (2, 7), (3, 2)):
            await User.create(
                id=uid,
                username=f"person{uid}",
                display_name=f"Person {uid}",
                password_hash="unused",
                color="#000000",
                created_at=1,
                contacts_version=version,
                profile_revision=9,
            )
        await db.execute("INSERT INTO contacts (owner_id,contact_id,created_at) VALUES (1,2,1),(2,1,3),(1,3,5)")
        return await users.create_session(1, "before11"), await db.rows(
            "SELECT * FROM contacts ORDER BY owner_id,contact_id"
        )
    finally:
        await db.close()


def test_migration11_archives_unilateral_and_preserves_reciprocal_identity_on_restart(
    tmp_path, database_url, monkeypatch
):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:10])
        m.setattr(db, "POSTGRES", db.POSTGRES[:10])
        token, legacy = asyncio.run(seed_v10(cfg))
    saved = None
    for _ in range(2):
        with TestClient(create_app(cfg)) as client:
            e = Env(client)
            assert e.c.portal is not None
            assert e.c.portal.call(db.rows, "SELECT * FROM contacts ORDER BY owner_id,contact_id") == legacy
            links = e.c.portal.call(db.rows, "SELECT * FROM contact_links ORDER BY owner_id,peer_id")
            assert len(links) == 2 and {row["state"] for row in links} == {"contact"}
            assert links[0]["request_id"] == links[1]["request_id"] and all(row["since"] == 3 for row in links)
            UUID(links[0]["request_id"])
            assert e.c.portal.call(db.rows, "SELECT id,contacts_version,profile_revision FROM users ORDER BY id") == [
                {"id": 1, "contacts_version": 1, "profile_revision": 9},
                {"id": 2, "contacts_version": 8, "profile_revision": 9},
                {"id": 3, "contacts_version": 3, "profile_revision": 9},
            ]
            body = e.do("POST", "/api/v1/users/profiles", token, {"ids": [2, 3]})[1]
            assert body["contact_ids"] == [2] and list(body["relations"]) == ["2"]
            assert body["incoming_count"] == 0
            if saved is not None:
                assert body == saved
            saved = body


async def test_failed_migration11_rolls_back_table_versions_and_backfill(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url)
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:10])
        m.setattr(db, "POSTGRES", db.POSTGRES[:10])
        _, legacy = await seed_v10(cfg)
    original = users.backfill_contact_links

    async def fail(tx):
        await original(tx)
        raise RuntimeError("after relation backfill")

    with monkeypatch.context() as m:
        m.setattr(users, "backfill_contact_links", fail)
        try:
            with pytest.raises(RuntimeError, match="after relation backfill"):
                await db.init(cfg.database_url, cfg.data_dir)
            assert await db.rows("SELECT version FROM schema_version") == [{"version": 10}]
            assert await db.rows("SELECT contacts_version FROM users ORDER BY id") == [
                {"contacts_version": 0},
                {"contacts_version": 7},
                {"contacts_version": 2},
            ]
            assert await db.rows("SELECT * FROM contacts ORDER BY owner_id,contact_id") == legacy
            sql = (
                "SELECT tablename AS name FROM pg_tables WHERE tablename='contact_links'"
                if database_url
                else "SELECT name FROM sqlite_master WHERE name='contact_links'"
            )
            assert await db.rows(sql) == []
        finally:
            await db.close()
    try:
        await db.init(cfg.database_url, cfg.data_dir)
        assert await db.rows("SELECT COUNT(*) AS n FROM contact_links") == [{"n": 2}]
        await User.filter(id=2).delete()
        assert await db.rows("SELECT * FROM contact_links") == []
        assert await db.rows("SELECT * FROM contacts") == [{"owner_id": 1, "contact_id": 3, "created_at": 5}]
    finally:
        await db.close()
