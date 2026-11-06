import asyncio

import httpx
import pytest
from test_group_order import group_env as group_env
from test_profile_watch import drain, open_socket

from tolktak import db
from tolktak.store import groups

MOD_ACTIONS = ["update", "add", "remove", "rename_room", "delete_room", "rename_channel", "delete_channel"]


def test_group_create_member_cap_includes_owner(group_env):
    e, owner, owner_id, _, _, _, _, _ = group_env
    others = [value for value in range(1, 202) if value != owner_id]
    code, body = e.do("POST", "/api/v1/groups", owner, {"name": "over cap", "members": others})
    assert code == 400 and body["error"]["code"] == "too_many_members"


def operation(e, gid, owner, mod, mod_id, outsider, action):
    group = next(g for g in e.do("GET", "/api/v1/groups", owner)[1]["groups"] if g["id"] == gid)
    member = next(uid for uid in group["members"] if uid not in (group["owner_id"], mod_id))
    outsider_id = e.do("GET", "/api/v1/me", outsider)[1]["user"]["id"]
    room = group["rooms"][-1]["id"]
    channel = group["text_channels"][-1]["id"]
    method, path, body, function = {
        "update": ("PATCH", f"/api/v1/groups/{gid}", {"name": "changed"}, "update_group"),
        "add": ("POST", f"/api/v1/groups/{gid}/members", {"user_ids": [outsider_id]}, "add_group_members"),
        "remove": ("DELETE", f"/api/v1/groups/{gid}/members/{member}", None, "remove_group_member"),
        "rename_room": ("PATCH", f"/api/v1/rooms/{room}", {"name": "changed"}, "rename_room"),
        "delete_room": ("DELETE", f"/api/v1/rooms/{room}", None, "delete_room"),
        "rename_channel": ("PATCH", f"/api/v1/text-channels/{channel}", {"name": "changed"}, "rename_text_channel"),
        "delete_channel": ("DELETE", f"/api/v1/text-channels/{channel}", None, "delete_text_channel"),
        "role": ("PUT", f"/api/v1/groups/{gid}/members/{member}/role", {"role": "mod"}, "set_group_role"),
        "delete_group": ("DELETE", f"/api/v1/groups/{gid}", None, "delete_group"),
    }[action]
    return method, path, body, function, (owner if action in ("role", "delete_group") else mod)


@pytest.mark.parametrize("action", MOD_ACTIONS + ["role", "delete_group"])
def test_administrative_write_rechecks_actor_after_api_precheck(group_env, monkeypatch, action):
    e, owner, owner_id, mod, mod_id, _, outsider, gid = group_env
    method, path, body, function, token = operation(e, gid, owner, mod, mod_id, outsider, action)
    original = getattr(groups, function)

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args, **kwargs):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "stale-admin":
                reached.set()
                await resume.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(groups, function, pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.request(method, path, json=body, headers={"Authorization": "Bearer " + token}),
                name="stale-admin",
            )
            try:
                await asyncio.wait_for(reached.wait(), 5)
                if token == owner:
                    await groups.remove_group_member(gid, owner_id, owner_id)
                else:
                    await groups.set_group_role(gid, mod_id, "member", owner_id)
                before = await groups.group_by_id(gid)
                resume.set()
                result = await asyncio.wait_for(writing, 5)
                assert result.status_code == (404 if token == owner else 403), result.text
                assert await groups.group_by_id(gid) == before
            finally:
                resume.set()
                if not writing.done():
                    writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)

    e.c.portal.call(race)


def test_kick_rechecks_promoted_targets_protection(group_env, monkeypatch):
    e, owner, owner_id, mod, mod_id, _, outsider, gid = group_env
    method, path, body, function, token = operation(e, gid, owner, mod, mod_id, outsider, "remove")
    target = int(path.rsplit("/", 1)[1])
    original = groups.remove_group_member

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args):
            reached.set()
            await resume.wait()
            return await original(*args)

        monkeypatch.setattr(groups, function, pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.request(method, path, json=body, headers={"Authorization": "Bearer " + token})
            )
            await asyncio.wait_for(reached.wait(), 5)
            await groups.set_group_role(gid, target, "mod", owner_id)
            resume.set()
            assert (await asyncio.wait_for(writing, 5)).status_code == 403
            assert await groups.is_group_member(gid, target)

    e.c.portal.call(race)


def test_last_owner_leave_uses_current_members_and_transfers_atomically(group_env, monkeypatch):
    e, owner, owner_id, _, _, _, outsider, _ = group_env
    outsider_id = e.do("GET", "/api/v1/me", outsider)[1]["user"]["id"]
    gid = e.do("POST", "/api/v1/groups", owner, {"name": "last"})[1]["group"]["id"]
    original = groups.remove_group_member

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args):
            reached.set()
            await resume.wait()
            return await original(*args)

        monkeypatch.setattr(groups, "remove_group_member", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            leaving = asyncio.create_task(
                client.delete(f"/api/v1/groups/{gid}/members/{owner_id}", headers={"Authorization": "Bearer " + owner})
            )
            await asyncio.wait_for(reached.wait(), 5)
            await groups.add_group_members(gid, [outsider_id], owner_id)
            resume.set()
            assert (await asyncio.wait_for(leaving, 5)).status_code == 204
            group = await groups.group_by_id(gid)
            assert group["owner_id"] == outsider_id and group["members"] == [outsider_id]

    e.c.portal.call(race)


def test_group_delete_notifies_members_added_after_the_api_snapshot(group_env, monkeypatch):
    e, owner, owner_id, _, _, _, outsider, gid = group_env
    outsider_id = e.do("GET", "/api/v1/me", outsider)[1]["user"]["id"]
    original = groups.delete_group

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args):
            reached.set()
            await resume.wait()
            return await original(*args)

        monkeypatch.setattr(groups, "delete_group", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            deleting = asyncio.create_task(
                client.delete(f"/api/v1/groups/{gid}", headers={"Authorization": "Bearer " + owner})
            )
            await asyncio.wait_for(reached.wait(), 5)
            await groups.add_group_members(gid, [outsider_id], owner_id)
            resume.set()
            assert (await asyncio.wait_for(deleting, 5)).status_code == 204

    with e.c.websocket_connect("/api/v1/ws") as socket:
        open_socket(e, socket, outsider)
        e.c.portal.call(race)
        frames = drain(e, socket, outsider_id, "deleted-current-members")
        assert [f["data"] for f in frames if f["type"] == "group.deleted"] == [{"id": gid}]


@pytest.mark.parametrize("resource,cap", [("rooms", 20), ("channels", 30)])
def test_concurrent_resource_creation_enforces_cap_inside_group_lock(group_env, monkeypatch, resource, cap):
    e, owner, owner_id, _, _, _, _, gid = group_env
    function = "create_room" if resource == "rooms" else "create_text_channel"
    original = getattr(groups, function)

    async def race():
        group = await groups.group_by_id(gid)
        current = len(group["rooms" if resource == "rooms" else "text_channels"])
        for index in range(cap - current - 1):
            await original(gid, f"filler {index}", owner_id)
        reached = 0
        together = asyncio.Event()

        async def pause(*args):
            nonlocal reached
            reached += 1
            if reached == 2:
                together.set()
            await asyncio.wait_for(together.wait(), 5)
            return await original(*args)

        monkeypatch.setattr(groups, function, pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:

            async def create(name):
                return await client.post(
                    f"/api/v1/groups/{gid}/{resource}",
                    json={"name": name},
                    headers={"Authorization": "Bearer " + owner},
                )

            responses = await asyncio.wait_for(asyncio.gather(create("first"), create("second")), 5)
            assert sorted(response.status_code for response in responses) == [201, 409]
        group = await groups.group_by_id(gid)
        values = group["rooms" if resource == "rooms" else "text_channels"]
        assert len(values) == cap and [value["position"] for value in values] == list(range(cap))

    e.c.portal.call(race)


@pytest.mark.parametrize("action", MOD_ACTIONS)
def test_postgres_group_lock_serializes_role_revocation_with_administration(
    group_env, database_url, monkeypatch, action
):
    if not database_url:
        pytest.skip("Requires independent PostgreSQL connections")
    import asyncpg

    e, owner, owner_id, mod, mod_id, _, outsider, gid = group_env
    method, path, body, _, token = operation(e, gid, owner, mod, mod_id, outsider, action)
    lock = groups.lock_group

    async def race():
        waiting = asyncio.Event()
        pid = 0

        async def record(gid, tx):
            nonlocal pid
            pid = (await db.rows("SELECT pg_backend_pid() AS pid", c=tx))[0]["pid"]
            waiting.set()
            await lock(gid, tx)

        monkeypatch.setattr(groups, "lock_group", record)
        revoker = await asyncpg.connect(database_url)
        probe = await asyncpg.connect(database_url)
        transaction = revoker.transaction()
        await transaction.start()
        writing = None
        try:
            await revoker.execute("UPDATE groups SET owner_id=owner_id WHERE id=$1", gid)
            await revoker.execute(
                "UPDATE group_members SET role='member' WHERE group_id=$1 AND user_id=$2", gid, mod_id
            )
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
                writing = asyncio.create_task(
                    client.request(method, path, json=body, headers={"Authorization": "Bearer " + token})
                )
                await asyncio.wait_for(waiting.wait(), 5)
                async with asyncio.timeout(5):
                    while not await probe.fetchval(  # noqa: ASYNC110 - observe an actual PostgreSQL lock wait
                        "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1", pid
                    ):
                        await asyncio.sleep(0.01)
                assert not writing.done()
                await transaction.commit()
                before = await groups.group_by_id(gid)
                response = await asyncio.wait_for(writing, 5)
                assert response.status_code == 403, response.text
                assert await groups.group_by_id(gid) == before
        finally:
            if writing is not None and not writing.done():
                writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)
            await revoker.close()
            await probe.close()

    e.c.portal.call(race)
