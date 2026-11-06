import asyncio

import httpx
import pytest
from test_profile_watch import drain, open_socket

from tolktak import db
from tolktak.store import groups


@pytest.fixture
def group_env(make_env):
    e = make_env()
    e.server.rl.disabled = True
    owner, owner_id = e.user("owner")
    mod, mod_id = e.user("moderator")
    member, member_id = e.user("member")
    outsider, _ = e.user("outsider")
    _, body = e.do("POST", "/api/v1/groups", owner, {"name": "G", "members": [mod_id, member_id]})
    group = body["group"]
    gid = group["id"]
    assert e.do("PUT", f"/api/v1/groups/{gid}/members/{mod_id}/role", owner, {"role": "mod"})[0] == 204
    for i in range(2):
        assert e.do("POST", f"/api/v1/groups/{gid}/channels", owner, {"name": f"text {i}"})[0] == 201
        assert e.do("POST", f"/api/v1/groups/{gid}/rooms", owner, {"name": f"voice {i}"})[0] == 201
    return e, owner, owner_id, mod, mod_id, member, outsider, gid


def current(e, token, gid, resource):
    group = next(g for g in e.do("GET", "/api/v1/groups", token)[1]["groups"] if g["id"] == gid)
    return [item["id"] for item in group["text_channels" if resource == "channels" else "rooms"]]


def order_path(gid, resource):
    return f"/api/v1/groups/{gid}/{'channel-order' if resource == 'channels' else 'room-order'}"


@pytest.mark.parametrize("resource", ["channels", "rooms"])
def test_group_order_is_atomic_authorized_and_idempotent(group_env, resource):
    e, owner, owner_id, mod, _, member, outsider, gid = group_env
    ids = current(e, owner, gid, resource)
    desired = list(reversed(ids))
    path = order_path(gid, resource)
    assert e.do("PUT", path, member, {"ids": desired})[0] == 403
    assert e.do("PUT", path, outsider, {"ids": desired})[0] == 404
    assert e.do("PUT", path, body={"ids": desired})[0] == 401
    with e.c.websocket_connect("/api/v1/ws") as socket:
        open_socket(e, socket, owner)
        assert e.do("PUT", path, mod, {"ids": desired})[0] == 204
        assert e.do("PUT", path, owner, {"ids": desired})[0] == 204
        frames = drain(e, socket, owner_id, "ordered")
        updates = [f["data"] for f in frames if f["type"] == "group.updated"]
        assert len(updates) == 1
        assert [item["id"] for item in updates[0]["text_channels" if resource == "channels" else "rooms"]] == desired
    assert current(e, owner, gid, resource) == desired
    assert e.do("GET", "/api/v1/server")[1]["capabilities"]["group_order"] == 1


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"ids": None},
        {"ids": "1,2"},
        {"ids": [True]},
        {"ids": [1.0]},
        {"ids": ["1"]},
        {"ids": [0]},
        {"ids": [-1]},
        {"ids": [9223372036854775808]},
        {"ids": [1, 1]},
    ],
)
def test_group_order_rejects_malformed_ids_without_changing_positions(group_env, body):
    e, owner, _, _, _, _, _, gid = group_env
    before = current(e, owner, gid, "channels")
    assert e.do("PUT", order_path(gid, "channels"), owner, body)[0] == 400
    assert current(e, owner, gid, "channels") == before


@pytest.mark.parametrize("resource", ["channels", "rooms"])
def test_stale_foreign_or_omitted_sets_do_not_drop_current_resources(group_env, resource):
    e, owner, _, _, _, _, _, gid = group_env
    before = current(e, owner, gid, resource)
    _, body = e.do("POST", "/api/v1/groups", owner, {"name": "other"})
    foreign = body["group"]["text_channels" if resource == "channels" else "rooms"][0]["id"]
    path = order_path(gid, resource)
    for ids in ([], before[:-1], [*before[:-1], foreign], [*before, 9223372036854775807]):
        assert e.do("PUT", path, owner, {"ids": ids})[0] == 409
        assert current(e, owner, gid, resource) == before
    assert e.do("POST", f"/api/v1/groups/{gid}/{resource}", owner, {"name": "created later"})[0] == 201
    after = current(e, owner, gid, resource)
    assert e.do("PUT", path, owner, {"ids": list(reversed(before))})[0] == 409
    assert current(e, owner, gid, resource) == after


@pytest.mark.parametrize("resource", ["channels", "rooms"])
@pytest.mark.parametrize("revocation", ["member", "role"])
def test_group_order_checks_current_permissions_inside_the_write(group_env, monkeypatch, resource, revocation):
    e, owner, _, mod, mod_id, _, _, gid = group_env
    before = current(e, owner, gid, resource)
    reorder = groups.set_order

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args):
            reached.set()
            await resume.wait()
            return await reorder(*args)

        monkeypatch.setattr(groups, "set_order", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.put(
                    order_path(gid, resource),
                    json={"ids": list(reversed(before))},
                    headers={"Authorization": "Bearer " + mod},
                )
            )
            try:
                await asyncio.wait_for(reached.wait(), 5)
                target = f"/api/v1/groups/{gid}/members/{mod_id}"
                revoked = await client.request(
                    "DELETE" if revocation == "member" else "PUT",
                    target if revocation == "member" else target + "/role",
                    headers={"Authorization": "Bearer " + owner},
                    json=None if revocation == "member" else {"role": "member"},
                )
                assert revoked.status_code == 204
                resume.set()
                response = await asyncio.wait_for(writing, 5)
                assert response.status_code == (404 if revocation == "member" else 403)
            finally:
                resume.set()
                if not writing.done():
                    writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)

    e.c.portal.call(race)
    assert current(e, owner, gid, resource) == before


@pytest.mark.parametrize("resource", ["channels", "rooms"])
@pytest.mark.parametrize("mutation", ["create", "delete"])
@pytest.mark.parametrize("first", ["order", "mutation"])
def test_postgres_order_serializes_with_resource_creation_and_deletion(
    group_env, database_url, monkeypatch, resource, mutation, first
):
    if not database_url:
        pytest.skip("Requires independent PostgreSQL connections")
    import asyncpg

    e, owner, _, _, _, _, _, gid = group_env
    before = current(e, owner, gid, resource)
    desired = list(reversed(before))
    target = before[-1]
    lock = groups.lock_group

    async def race():
        locked, waiting, resume = asyncio.Event(), asyncio.Event(), asyncio.Event()
        waiter_pid = 0

        async def pause(gid, tx):
            nonlocal waiter_pid
            task = asyncio.current_task()
            name = task.get_name() if task is not None else ""
            if name != first and name in ("order", "mutation"):
                waiter_pid = (await db.rows("SELECT pg_backend_pid() AS pid", c=tx))[0]["pid"]
                waiting.set()
            await lock(gid, tx)
            if name == first:
                locked.set()
                await resume.wait()

        monkeypatch.setattr(groups, "lock_group", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            headers = {"Authorization": "Bearer " + owner}

            async def reorder():
                return await client.put(order_path(gid, resource), json={"ids": desired}, headers=headers)

            async def mutate():
                if mutation == "create":
                    return await client.post(
                        f"/api/v1/groups/{gid}/{resource}", json={"name": "raced"}, headers=headers
                    )
                path = f"/api/v1/{'text-channels' if resource == 'channels' else 'rooms'}/{target}"
                return await client.delete(path, headers=headers)

            functions = {"order": reorder, "mutation": mutate}
            tasks = [asyncio.create_task(functions[first](), name=first)]
            probe = await asyncpg.connect(database_url)
            try:
                await asyncio.wait_for(locked.wait(), 5)
                second = "mutation" if first == "order" else "order"
                tasks.append(asyncio.create_task(functions[second](), name=second))
                await asyncio.wait_for(waiting.wait(), 5)

                async def observe():
                    while not await probe.fetchval(  # noqa: ASYNC110 - observe an actual PostgreSQL row-lock wait
                        "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1", waiter_pid
                    ):
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(observe(), 5)
                assert not tasks[1].done()
                resume.set()
                responses = await asyncio.wait_for(asyncio.gather(*tasks), 5)
                return dict(zip((first, second), responses, strict=True))
            finally:
                resume.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await probe.close()

    responses = e.c.portal.call(race)
    assert responses["order"].status_code == (204 if first == "order" else 409)
    assert responses["mutation"].status_code == (201 if mutation == "create" else 204)
    after = current(e, owner, gid, resource)
    base = desired if first == "order" else before
    if mutation == "create":
        created = responses["mutation"].json()["channel" if resource == "channels" else "room"]["id"]
        assert after == [*base, created]
    else:
        assert after == [item for item in base if item != target]
