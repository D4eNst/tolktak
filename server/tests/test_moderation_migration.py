import asyncio

from conftest import Env, make_config
from fastapi.testclient import TestClient
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.app import create_app
from tolktak.store import moderation as store


def test_v9_rooms_profiles_and_persistent_restrictions_survive_migration_restart(tmp_path, database_url, monkeypatch):
    cfg = make_config(tmp_path, database_url, signaling_private=True)
    # Seed v9 through current APIs: user schema is already current before migration10.
    with monkeypatch.context() as m:
        m.setattr(db, "SQLITE", db.SQLITE[:9])
        m.setattr(db, "POSTGRES", db.POSTGRES[:9])

        async def seed():
            await db.init(cfg.database_url, cfg.data_dir)
            try:
                from tolktak.models import User
                from tolktak.store import users

                for i in (1, 2):
                    await User.create(
                        id=i,
                        username=f"person{i}",
                        display_name=f"Person {i}",
                        password_hash="unused",
                        created_at=1,
                        color="#000000",
                    )
                await db.execute("INSERT INTO channels (kind, created_at) VALUES ('group', 1)")
                await db.execute("INSERT INTO groups (name, owner_id, channel_id, created_at) VALUES ('G', 1, 1, 1)")
                await db.execute("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (1, 1, 1), (1, 2, 1)")
                await db.execute("INSERT INTO channel_members (channel_id, user_id) VALUES (1, 1), (1, 2)")
                await db.execute("INSERT INTO rooms (group_id, name, position, created_at) VALUES (1, 'Voice', 0, 1)")
                return await users.create_session(1, "before migration10")
            finally:
                await db.close()

        token = asyncio.run(seed())
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        assert e.c.portal is not None
        assert e.do("GET", "/api/v1/groups", token)[1]["groups"][0]["rooms"] == [
            {"id": 1, "group_id": 1, "name": "Voice", "position": 0}
        ]

        async def rules():
            await store.observe(1, True)
            await store.change_rule(1, 1, 2, "microphone", "call")
            await store.change_rule(1, 1, 2, "camera", "permanent")
            return await store.snapshot(1, 2)

        saved = e.c.portal.call(rules)
        assert saved["allowed"]["microphone"] is False and saved["allowed"]["camera"] is False
    with TestClient(create_app(cfg)) as client:
        e = Env(client)
        assert e.c.portal is not None
        assert e.c.portal.call(store.snapshot, 1, 2) == saved

        async def finish():
            async with in_transaction(db.CONN):
                await store.observe(1, False)
            return await store.snapshot(1, 2)

        ended = e.c.portal.call(finish)
        assert ended["allowed"]["microphone"] is True and ended["allowed"]["camera"] is False
