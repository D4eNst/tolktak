import asyncio

import httpx
import pytest
from obstore.store import MemoryStore
from test_features import TINY_PNG

from tolktak import db
from tolktak.api.files import remove_unused_files
from tolktak.models import Message
from tolktak.storage import S3Files
from tolktak.store import users


@pytest.mark.parametrize("mode", ["closed", "invite"])
def test_concurrent_bootstrap_requests_cannot_bypass_registration_policy(make_env, monkeypatch, mode):
    e = make_env(mode)
    e.server.rl.disabled = True
    hash_password = users.hash_password

    async def race():
        both = asyncio.Event()
        arrived = 0

        async def pause(password):
            nonlocal arrived
            result = await hash_password(password)
            arrived += 1
            if arrived == 2:
                both.set()
            await asyncio.wait_for(both.wait(), 5)
            return result

        monkeypatch.setattr(users, "hash_password", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            responses = await asyncio.gather(
                *[
                    client.post("/api/v1/auth/register", json={"username": name, "password": "password123"})
                    for name in ("firsta", "firstb")
                ]
            )
        assert sorted(response.status_code for response in responses) == [201, 403]
        created = next(response.json()["user"] for response in responses if response.status_code == 201)
        assert created["is_admin"] is True and await users.count_users() == 1
        rejected = next(response.json()["error"]["code"] for response in responses if response.status_code == 403)
        assert rejected == ("registration_closed" if mode == "closed" else "invite_required")

    e.c.portal.call(race)


@pytest.mark.parametrize("backend", ["disk", "s3"])
def test_postgres_file_cleanup_waits_for_attachment_commit(make_env, database_url, monkeypatch, backend):
    if not database_url:
        pytest.skip("Requires independent PostgreSQL connections")
    import asyncpg

    e = make_env()
    e.server.rl.disabled = True
    if backend == "s3":
        e.server.files = S3Files(MemoryStore())
    token, _ = e.user("owner")
    _, peer = e.user("peer")
    cid = e.do("POST", "/api/v1/dms", token, {"user_id": peer})[1]["channel"]["id"]
    fid = e.upload(token, "photo.png", TINY_PNG)[1]["file"]["id"]
    create = Message.create

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args, **kwargs):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "attaching":
                reached.set()
                await resume.wait()
            return await create(*args, **kwargs)

        monkeypatch.setattr(Message, "create", pause)
        probe = await asyncpg.connect(database_url)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            attaching = asyncio.create_task(
                client.post(
                    f"/api/v1/channels/{cid}/messages",
                    json={"nonce": "attachment-race", "attachments": [fid]},
                    headers={"Authorization": "Bearer " + token},
                ),
                name="attaching",
            )
            cleaning = None
            try:
                await asyncio.wait_for(reached.wait(), 5)
                cleaning = asyncio.create_task(remove_unused_files(e.server, [fid]))
                async with asyncio.timeout(5):
                    while not cleaning.done() and not await probe.fetchval(  # noqa: ASYNC110 - observe actual PG lock
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
                        "AND wait_event_type='Lock' AND query ILIKE '%files%')"
                    ):
                        await asyncio.sleep(0.01)
                resume.set()
                response, _ = await asyncio.wait_for(asyncio.gather(attaching, cleaning), 5)
                assert response.status_code == 200, response.text
                assert [file["id"] for file in response.json()["message"]["attachments"]] == [fid]
                assert await db.rows("SELECT id FROM files WHERE id=?", [fid]) == [{"id": fid}]
            finally:
                resume.set()
                for task in (attaching, cleaning):
                    if task is not None and not task.done():
                        task.cancel()
                await asyncio.gather(
                    *[task for task in (attaching, cleaning) if task is not None], return_exceptions=True
                )
                await probe.close()

    e.c.portal.call(race)
    assert e.c.get(f"/api/v1/files/{fid}").status_code == 200


@pytest.mark.parametrize("backend", ["disk", "s3"])
def test_cleanup_commits_metadata_before_blob_delete_and_rejects_new_attachment(make_env, monkeypatch, backend):
    e = make_env()
    e.server.rl.disabled = True
    if backend == "s3":
        e.server.files = S3Files(MemoryStore())
    token, _ = e.user("owner")
    _, peer = e.user("peer")
    cid = e.do("POST", "/api/v1/dms", token, {"user_id": peer})[1]["channel"]["id"]
    fid = e.upload(token, "photo.png", TINY_PNG)[1]["file"]["id"]
    delete = e.server.files.delete

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(fid):
            reached.set()
            await resume.wait()
            return await delete(fid)

        monkeypatch.setattr(e.server.files, "delete", pause)
        cleaning = asyncio.create_task(remove_unused_files(e.server, [fid]))
        try:
            await asyncio.wait_for(reached.wait(), 5)
            assert await db.rows("SELECT id FROM files WHERE id=?", [fid]) == []
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
                response = await client.post(
                    f"/api/v1/channels/{cid}/messages",
                    json={"nonce": "after-cleanup", "attachments": [fid]},
                    headers={"Authorization": "Bearer " + token},
                )
            assert response.status_code == 404 and response.json()["error"]["code"] == "file_missing"
            assert await db.rows("SELECT id FROM messages WHERE nonce='after-cleanup'") == []
        finally:
            resume.set()
            await asyncio.wait_for(cleaning, 5)

    e.c.portal.call(race)
    assert e.c.get(f"/api/v1/files/{fid}").status_code == 404


@pytest.mark.parametrize("resource", ["user", "group"])
@pytest.mark.parametrize("first", ["avatar", "cleanup"])
def test_cleanup_and_avatar_assignment_share_file_lock(make_env, database_url, monkeypatch, resource, first):
    if first == "avatar" and not database_url:
        pytest.skip("Requires independent PostgreSQL connections")
    e = make_env()
    e.server.rl.disabled = True
    token, uid = e.user("owner")
    gid = e.do("POST", "/api/v1/groups", token, {"name": "G"})[1]["group"]["id"]
    fid = e.upload(token, "avatar.png", TINY_PNG)[1]["file"]["id"]
    from tolktak.store import files, groups

    module = users if resource == "user" else groups
    function = "update_profile" if resource == "user" else "update_group"
    path = "/api/v1/me" if resource == "user" else f"/api/v1/groups/{gid}"
    writer = getattr(module, function)
    lock = files.lock_files

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause_writer(*args, **kwargs):
            reached.set()
            await resume.wait()
            return await writer(*args, **kwargs)

        async def pause_lock(*args, **kwargs):
            result = await lock(*args, **kwargs)
            task = asyncio.current_task()
            if task is not None and task.get_name() == "avatar-write":
                reached.set()
                await resume.wait()
            return result

        if first == "cleanup":
            monkeypatch.setattr(module, function, pause_writer)
        else:
            monkeypatch.setattr(files, "lock_files", pause_lock)
        cleaning = None
        probe = None
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.patch(path, json={"avatar": fid}, headers={"Authorization": "Bearer " + token}),
                name="avatar-write",
            )
            try:
                await asyncio.wait_for(reached.wait(), 5)
                cleaning = asyncio.create_task(remove_unused_files(e.server, [fid]))
                if first == "cleanup":
                    await asyncio.wait_for(cleaning, 5)
                else:
                    import asyncpg

                    probe = await asyncpg.connect(database_url)
                    async with asyncio.timeout(5):
                        while not cleaning.done() and not await probe.fetchval(  # noqa: ASYNC110 - observe PG row lock
                            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
                            "AND wait_event_type='Lock' AND query ILIKE '%files%')"
                        ):
                            await asyncio.sleep(0.01)
                    assert not cleaning.done()
                resume.set()
                response, _ = await asyncio.wait_for(asyncio.gather(writing, cleaning), 5)
                if first == "cleanup":
                    assert response.status_code == 400 and response.json()["error"]["code"] == "bad_avatar"
                else:
                    assert response.status_code == (200 if resource == "user" else 204), response.text
                current = (await users.user_by_id(uid)) if resource == "user" else (await groups.group_by_id(gid))
                assert current["avatar"] == (fid if first == "avatar" else "")
            finally:
                resume.set()
                for task in (writing, cleaning):
                    if task is not None and not task.done():
                        task.cancel()
                await asyncio.gather(
                    *[task for task in (writing, cleaning) if task is not None], return_exceptions=True
                )
                if probe is not None:
                    await probe.close()

    e.c.portal.call(race)
    assert e.c.get(f"/api/v1/files/{fid}").status_code == (200 if first == "avatar" else 404)


def test_invite_consumption_rolls_back_on_conflict_and_respects_last_use(make_env, monkeypatch):
    e = make_env("invite")
    e.server.rl.disabled = True
    admin, _ = e.user("admin")
    invite = e.do("POST", "/api/v1/admin/invites", admin, {"max_uses": 1})[1]["invite"]["code"]
    assert (
        e.do("POST", "/api/v1/auth/register", body={"username": "admin", "password": "password123", "invite": invite})[
            0
        ]
        == 409
    )
    assert e.c.portal.call(db.rows, "SELECT uses FROM invites WHERE code=?", [invite]) == [{"uses": 0}]
    original = users.hash_password

    async def race():
        both = asyncio.Event()
        count = 0

        async def pause(password):
            nonlocal count
            hashed = await original(password)
            count += 1
            if count == 2:
                both.set()
            await asyncio.wait_for(both.wait(), 5)
            return hashed

        monkeypatch.setattr(users, "hash_password", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            responses = await asyncio.gather(
                *[
                    client.post(
                        "/api/v1/auth/register", json={"username": name, "password": "password123", "invite": invite}
                    )
                    for name in ("one", "two")
                ]
            )
        assert sorted(response.status_code for response in responses) == [201, 403]
        assert (
            next(response for response in responses if response.status_code == 403).json()["error"]["code"]
            == "invite_invalid"
        )
        assert await db.rows("SELECT uses FROM invites WHERE code=?", [invite]) == [{"uses": 1}]
        assert await users.count_users() == 2

    e.c.portal.call(race)
