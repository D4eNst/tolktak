import asyncio
from uuid import uuid4

import httpx
import pytest
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.store import chat, groups, users


@pytest.fixture
def conversation(make_env):
    e = make_env()
    e.server.rl.disabled = True
    alice, alice_id = e.user("alice")
    bob, bob_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", alice, {"user_id": bob_id})
    return e, alice, alice_id, bob, bob_id, body["channel"]["id"]


def send(e, token, cid, text="message", **fields):
    code, body = e.do("POST", f"/api/v1/channels/{cid}/messages", token, {"text": text, "nonce": uuid4().hex, **fields})
    assert code == 200, body
    return body["message"]


def changes(e, token, cid, since=0, limit=100):
    code, body = e.do("GET", f"/api/v1/channels/{cid}/changes?since={since}&limit={limit}", token)
    assert code == 200, body
    return body


def test_changes_zero_cursor_idempotency_latest_states_and_tombstones(conversation):
    e, alice, alice_id, bob, _, cid = conversation
    empty = changes(e, bob, cid)
    assert empty == {
        "messages": [],
        "users": [],
        "history_version": 0,
        "complete": True,
        "read": {"message_id": 0, "unread": 0},
    }
    first = send(e, alice, cid, "first", nonce="stable")
    second = send(e, alice, cid, "second")
    send(e, alice, cid, "first", nonce="stable")
    assert changes(e, bob, cid)["history_version"] == 2
    for text in ("edit one", "edit two"):
        assert e.do("PATCH", f"/api/v1/messages/{first['id']}", alice, {"text": text})[0] == 200
    assert e.do("DELETE", f"/api/v1/messages/{second['id']}", alice)[0] == 200
    page = changes(e, bob, cid)
    assert page["complete"] is True and page["history_version"] == 5
    assert [(m["id"], m["revision"]) for m in page["messages"]] == [(first["id"], 4), (second["id"], 5)]
    assert page["messages"][0]["text"] == "edit two"
    tombstone = page["messages"][1]
    assert tombstone["deleted"] is True and tombstone["text"] == ""
    assert tombstone["attachments"] == tombstone["reactions"] == []
    assert [u["id"] for u in page["users"]] == [alice_id]
    assert all("password_hash" not in u for u in page["users"])
    assert page["read"] == {"message_id": 0, "unread": 1}
    assert changes(e, bob, cid) == page
    assert changes(e, bob, cid, since=4)["messages"] == [tombstone]
    assert changes(e, bob, cid, since=5)["messages"] == []
    code, conflict = e.do("GET", f"/api/v1/channels/{cid}/changes?since=6", bob)
    assert code == 409 and conflict["error"]["code"] == "conflict"
    assert e.do("GET", "/api/v1/server")[1]["capabilities"]["changes"] == 1


def test_changes_overflow_is_explicit_and_bounded(conversation):
    e, alice, _, bob, _, cid = conversation
    for i in range(102):
        send(e, alice, cid, str(i))
    code, page = e.do("GET", f"/api/v1/channels/{cid}/changes?since=0", bob)
    assert code == 200 and len(page["messages"]) == 100
    assert page["complete"] is False and page["history_version"] == 102
    assert page["read"]["unread"] == 102
    bounded = changes(e, bob, cid, limit=1)
    assert len(bounded["messages"]) == 1 and bounded["complete"] is False
    assert changes(e, bob, cid, since=101, limit=1)["complete"] is True


@pytest.mark.parametrize(
    "query",
    [
        "",
        "since=-1",
        "since=+1",
        "since=1.0",
        "since=true",
        "since=",
        "since=9223372036854775808",
        "since=0&since=1",
        "since=0&limit=0",
        "since=0&limit=101",
        "since=0&limit=1&limit=2",
        "since=0&unknown=1",
        "since=0&limit=1.0",
    ],
)
def test_changes_query_is_strict(conversation, query):
    e, alice, _, _, _, cid = conversation
    assert e.do("GET", f"/api/v1/channels/{cid}/changes?{query}", alice)[0] == 400


def test_changes_requires_access_before_exposing_cursor_validity(conversation):
    e, alice, _, bob, bob_id, cid = conversation
    carol, _ = e.user("carol")
    assert e.do("GET", f"/api/v1/channels/{cid}/changes?since=0")[0] == 401
    assert e.do("GET", f"/api/v1/channels/{cid}/changes?since=999", carol)[0] == 404
    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "group", "members": [bob_id]})
    group = body["group"]
    assert e.do("DELETE", f"/api/v1/groups/{group['id']}/members/{bob_id}", alice)[0] == 204
    assert e.do("GET", f"/api/v1/channels/{group['channel_id']}/changes?since=0", bob)[0] == 404


def test_reply_revision_and_deleted_target_remain_valid_for_queued_sends(conversation):
    e, alice, _, bob, _, cid = conversation
    original = send(e, alice, cid, "original")
    reply = send(e, bob, cid, "reply", reply_to=original["id"])
    assert reply["reply"]["revision"] == original["revision"] == 1
    assert e.do("DELETE", f"/api/v1/messages/{original['id']}", alice)[0] == 200
    page = changes(e, bob, cid, since=2)
    assert [m["id"] for m in page["messages"]] == [original["id"]]
    queued = send(e, bob, cid, "queued reply", reply_to=original["id"])
    assert queued["reply"] == {
        "id": original["id"],
        "author_id": original["author_id"],
        "text": "",
        "deleted": True,
        "attachments": 0,
        "revision": 3,
    }
    assert (
        e.do("GET", f"/api/v1/channels/{cid}/history?around={reply['id']}&limit=1", bob)[1]["messages"][0]["reply"]
        == queued["reply"]
    )


def test_summary_uses_latest_visible_message_and_files_have_distinct_errors(conversation):
    e, alice, _, bob, _, cid = conversation
    first = send(e, alice, cid, "visible")
    second = send(e, alice, cid, "delete")
    assert e.do("DELETE", f"/api/v1/messages/{second['id']}", alice)[0] == 200
    summary = next(c for c in e.do("GET", "/api/v1/channels", bob)[1]["channels"] if c["id"] == cid)
    assert summary["last_message"]["id"] == first["id"]
    assert summary["unread"] == 1
    own_file = e.upload(alice, "a.txt", b"a")[1]["file"]["id"]
    for fid, status, error in (
        ("a" * 32, 404, "file_missing"),
        (own_file, 403, "bad_file"),
        ("invalid", 400, "bad_file"),
    ):
        code, body = e.do("POST", f"/api/v1/channels/{cid}/messages", bob, {"nonce": uuid4().hex, "attachments": [fid]})
        assert code == status and body["error"]["code"] == error


def test_twenty_reaction_types_allow_joining_existing_type(conversation):
    e, alice, _, bob, bob_id, cid = conversation
    message = send(e, alice, cid)
    emoji = [
        "😀",
        "😃",
        "😄",
        "😁",
        "😆",
        "😅",
        "😂",
        "🤣",
        "😊",
        "😇",
        "🙂",
        "🙃",
        "😉",
        "😌",
        "😍",
        "🥰",
        "😘",
        "😗",
        "😙",
        "😚",
    ]
    path = f"/api/v1/messages/{message['id']}/reactions"
    for value in emoji:
        assert e.do("POST", path, alice, {"emoji": value})[0] == 200
    code, body = e.do("POST", path, bob, {"emoji": emoji[0]})
    assert code == 200 and bob_id in body["message"]["reactions"][0]["users"]
    assert e.do("POST", path, bob, {"emoji": "👍"})[0] == 400
    assert e.do("POST", path, bob, {"emoji": emoji[0]})[0] == 200


def test_changes_profiles_and_read_state_share_the_message_snapshot(conversation, monkeypatch):
    e, alice, alice_id, bob, _, cid = conversation
    message = send(e, alice, cid, "before")
    profiles = users.profiles_by_ids

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(ids, c=None):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "changes-reader":
                assert c is not None
                reached.set()
                await resume.wait()
            return await profiles(ids, c)

        monkeypatch.setattr(users, "profiles_by_ids", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            headers = {"Authorization": "Bearer " + alice}
            reading = asyncio.create_task(
                client.get(f"/api/v1/channels/{cid}/changes?since=0", headers=headers), name="changes-reader"
            )
            await asyncio.wait_for(reached.wait(), 5)

            async def write():
                async with in_transaction(db.CONN) as tx:
                    await db.execute("UPDATE users SET display_name = 'after' WHERE id = ?", [alice_id], tx)
                    await db.execute(
                        "UPDATE messages SET text = 'after', revision = 2 WHERE id = ?", [message["id"]], tx
                    )
                    await db.execute("UPDATE channels SET history_version = 2 WHERE id = ?", [cid], tx)
                    await db.execute(
                        "UPDATE channel_members SET last_read_id = ? WHERE channel_id = ?", [message["id"], cid], tx
                    )

            writing = asyncio.create_task(write())
            try:
                await asyncio.wait([writing], timeout=0.05)
                resume.set()
                response, _ = await asyncio.wait_for(asyncio.gather(reading, writing), 5)
                return response.json()
            finally:
                resume.set()
                for task in (reading, writing):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(reading, writing, return_exceptions=True)

    page = e.c.portal.call(race)
    assert page["history_version"] == 1
    assert page["messages"][0]["text"] == "before"
    assert page["users"][0]["display_name"] == "alice"
    assert page["read"] == {"message_id": 0, "unread": 0}
    latest = changes(e, bob, cid)
    assert latest["history_version"] == 2 and latest["users"][0]["display_name"] == "after"
    assert latest["messages"][0]["text"] == "after"
    assert latest["read"] == {"message_id": message["id"], "unread": 0}


@pytest.mark.parametrize("operation", ["create", "edit", "delete", "react", "pin"])
@pytest.mark.parametrize("revocation", ["member", "role"])
def test_http_message_mutations_recheck_revoked_access_inside_write(conversation, monkeypatch, operation, revocation):
    if revocation == "role" and operation not in ("delete", "pin"):
        pytest.skip("Ordinary membership allows this operation")
    e, alice, _, bob, bob_id, _ = conversation
    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "group", "members": [bob_id]})
    group = body["group"]
    cid, gid = group["channel_id"], group["id"]
    e.do("PUT", f"/api/v1/groups/{gid}/members/{bob_id}/role", alice, {"role": "mod"})
    message = send(e, alice if revocation == "role" else bob, cid)
    methods = {
        "create": "create_message",
        "edit": "edit_message",
        "delete": "delete_message",
        "react": "toggle_reaction",
        "pin": "set_pinned",
    }
    original = getattr(chat, methods[operation])
    path = f"/api/v1/messages/{message['id']}"
    method, target, data = {
        "create": ("POST", f"/api/v1/channels/{cid}/messages", {"text": "late", "nonce": "late"}),
        "edit": ("PATCH", path, {"text": "late"}),
        "delete": ("DELETE", path, None),
        "react": ("POST", path + "/reactions", {"emoji": "👍"}),
        "pin": ("POST", path + "/pin", None),
    }[operation]

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(*args, **kwargs):
            reached.set()
            await resume.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(chat, methods[operation], pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.request(method, target, json=data, headers={"Authorization": "Bearer " + bob})
            )
            try:
                await asyncio.wait_for(reached.wait(), 5)
                revoke_path = f"/api/v1/groups/{gid}/members/{bob_id}"
                revoked = await client.request(
                    "DELETE" if revocation == "member" else "PUT",
                    revoke_path if revocation == "member" else revoke_path + "/role",
                    headers={"Authorization": "Bearer " + alice},
                    json=None if revocation == "member" else {"role": "member"},
                )
                assert revoked.status_code == 204
                resume.set()
                response = await asyncio.wait_for(writing, 5)
                assert response.status_code == (404 if revocation == "member" else 403), response.text
            finally:
                resume.set()
                if not writing.done():
                    writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)

    e.c.portal.call(race)
    assert changes(e, alice, cid)["history_version"] == 1
    assert e.c.portal.call(chat.message_by_id, message["id"]) == message


@pytest.mark.parametrize(
    "operation,revocation",
    [
        ("create", "member"),
        ("edit", "member"),
        ("delete", "member"),
        ("react", "member"),
        ("pin", "member"),
        ("delete", "role"),
        ("pin", "role"),
    ],
)
@pytest.mark.parametrize("first", ["message", "revoke"])
def test_postgres_message_and_revocation_wait_for_the_same_group_lock(
    conversation, database_url, monkeypatch, operation, revocation, first
):
    if not database_url:
        pytest.skip("Requires independent PostgreSQL connections")
    import asyncpg

    e, alice, _, bob, bob_id, _ = conversation
    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "group", "members": [bob_id]})
    group = body["group"]
    gid, cid = group["id"], group["channel_id"]
    e.do("PUT", f"/api/v1/groups/{gid}/members/{bob_id}/role", alice, {"role": "mod"})
    message = send(e, bob if operation == "edit" else alice, cid)
    original = groups.lock_group

    async def race():
        locked, resume, waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
        waiter_pid = 0

        async def pause(gid, tx):
            nonlocal waiter_pid
            task = asyncio.current_task()
            name = task.get_name() if task is not None else ""
            if name != first and name in ("message", "revoke"):
                waiter_pid = (await db.rows("SELECT pg_backend_pid() AS pid", c=tx))[0]["pid"]
                waiting.set()
            await original(gid, tx)
            if name == first:
                locked.set()
                await resume.wait()

        monkeypatch.setattr(groups, "lock_group", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:

            async def write():
                path = f"/api/v1/messages/{message['id']}"
                method, target, data = {
                    "create": ("POST", f"/api/v1/channels/{cid}/messages", {"text": "late", "nonce": "late"}),
                    "edit": ("PATCH", path, {"text": "late"}),
                    "delete": ("DELETE", path, None),
                    "react": ("POST", path + "/reactions", {"emoji": "👍"}),
                    "pin": ("POST", path + "/pin", None),
                }[operation]
                return await client.request(method, target, json=data, headers={"Authorization": "Bearer " + bob})

            async def revoke():
                path = f"/api/v1/groups/{gid}/members/{bob_id}"
                return await client.request(
                    "DELETE" if revocation == "member" else "PUT",
                    path if revocation == "member" else path + "/role",
                    headers={"Authorization": "Bearer " + alice},
                    json=None if revocation == "member" else {"role": "member"},
                )

            functions = {"message": write, "revoke": revoke}
            tasks = [asyncio.create_task(functions[first](), name=first)]
            probe = await asyncpg.connect(database_url)
            try:
                await asyncio.wait_for(locked.wait(), 5)
                second = "revoke" if first == "message" else "message"
                tasks.append(asyncio.create_task(functions[second](), name=second))
                await asyncio.wait_for(waiting.wait(), 5)

                async def wait_for_database_lock():
                    while not await probe.fetchval(  # noqa: ASYNC110 - observe PostgreSQL, not an app event
                        "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1", waiter_pid
                    ):
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(wait_for_database_lock(), 5)
                assert not tasks[1].done(), "The second write must wait inside PostgreSQL"
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
    assert responses["revoke"].status_code == 204
    expected = 200 if first == "message" else (404 if revocation == "member" else 403)
    assert responses["message"].status_code == expected, responses["message"].text
    page = changes(e, alice, cid)
    assert page["history_version"] == (2 if first == "message" else 1)
    if first == "revoke":
        assert page["messages"] == [message]
    elif operation == "create":
        assert len(page["messages"]) == 2 and page["messages"][-1]["text"] == "late"
    elif operation == "edit":
        assert page["messages"][0]["text"] == "late"
    elif operation == "delete":
        assert page["messages"][0]["deleted"] is True
    elif operation == "react":
        assert page["messages"][0]["reactions"] == [{"emoji": "👍", "users": [bob_id]}]
    else:
        assert page["messages"][0]["pinned_at"] is not None
