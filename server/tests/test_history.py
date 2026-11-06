import asyncio
import json
from urllib.parse import urlencode
from uuid import uuid4

import httpx
import pytest
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.models import Message
from tolktak.store import chat


@pytest.fixture
def conversation(make_env):
    e = make_env()
    e.server.rl.disabled = True
    alice, _ = e.user("alice")
    bob, bob_id = e.user("bob")
    code, body = e.do("POST", "/api/v1/dms", alice, {"user_id": bob_id})
    assert code == 200, body
    return e, alice, bob, body["channel"]["id"]


def send(e, token, cid, text, **fields):
    code, body = e.do("POST", f"/api/v1/channels/{cid}/messages", token, {"text": text, "nonce": uuid4().hex, **fields})
    assert code == 200, body
    return body["message"]


def history(e, token, cid, **query):
    code, body = e.do("GET", f"/api/v1/channels/{cid}/history?{urlencode(query)}", token)
    assert code == 200, body
    return body


def ids(page):
    return [m["id"] for m in page["messages"]]


def test_history_pages_have_stable_order_and_explicit_edges(conversation):
    e, alice, bob, cid = conversation
    messages = [send(e, alice, cid, f"m{i}") for i in range(13)]
    for index in (0, 5, 12):
        assert e.do("DELETE", f"/api/v1/messages/{messages[index]['id']}", alice)[0] == 200
    visible = [m["id"] for i, m in enumerate(messages) if i not in (0, 5, 12)]

    newest = history(e, bob, cid, limit=4)
    assert ids(newest) == visible[-4:]
    assert (newest["first_id"], newest["last_id"]) == (visible[-4], visible[-1])
    assert newest["has_before"] is True and newest["has_after"] is False

    older = history(e, bob, cid, before=newest["first_id"], limit=4)
    assert ids(older) == visible[-8:-4]
    assert older["has_before"] is True and older["has_after"] is True
    oldest = history(e, bob, cid, before=older["first_id"], limit=4)
    assert ids(oldest) == visible[:2]
    assert oldest["has_before"] is False and oldest["has_after"] is True

    newer = history(e, bob, cid, after=oldest["last_id"], limit=4)
    assert ids(newer) == visible[2:6]
    assert newer["has_before"] is True and newer["has_after"] is True
    assert all(not m["deleted"] for page in (oldest, older, newest, newer) for m in page["messages"])


@pytest.mark.parametrize("limit", [1, 4, 5, 8])
def test_history_context_balances_neighbours_and_refills_at_edges(conversation, limit):
    e, alice, bob, cid = conversation
    messages = [send(e, alice, cid, f"m{i}") for i in range(15)]
    visible = [m["id"] for m in messages]
    middle = history(e, bob, cid, around=visible[7], limit=limit)
    before = (limit - 1) // 2
    assert ids(middle) == visible[7 - before : 7 - before + limit]
    assert middle["has_before"] is True and middle["has_after"] is True

    first = history(e, bob, cid, around=visible[0], limit=limit)
    assert ids(first) == visible[:limit]
    assert first["has_before"] is False and first["has_after"] is True
    last = history(e, bob, cid, around=visible[-1], limit=limit)
    assert ids(last) == visible[-limit:]
    assert last["has_before"] is True and last["has_after"] is False


def test_empty_history_and_exhausted_pages_keep_their_direction(conversation):
    e, alice, bob, cid = conversation
    empty = history(e, bob, cid)
    assert empty["messages"] == empty["users"] == []
    assert empty["first_id"] is None and empty["last_id"] is None
    assert empty["has_before"] is False and empty["has_after"] is False
    assert empty["history_version"] == 0
    assert empty["read"] == {"message_id": 0, "unread": 0}

    message = send(e, alice, cid, "only")
    before = history(e, bob, cid, before=message["id"])
    after = history(e, bob, cid, after=message["id"])
    for page in (before, after):
        assert page["messages"] == []
        assert page["first_id"] is None and page["last_id"] is None
    assert before["has_before"] is False and before["has_after"] is True
    assert after["has_before"] is True and after["has_after"] is False
    assert after["read"] == {"message_id": 0, "unread": 1}

    assert e.do("DELETE", f"/api/v1/messages/{message['id']}", alice)[0] == 200
    deleted = history(e, bob, cid)
    assert deleted["messages"] == []
    assert deleted["has_before"] is False and deleted["has_after"] is False


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=101",
        "limit=-1",
        "limit=1.5",
        "limit=abc",
        "limit=",
        "limit=1&limit=2",
        "before=0",
        "before=-1",
        "before=+1",
        "after=-1",
        "after=1.5",
        "around=abc",
        "around=",
        "before=9223372036854775808",
        "after=1&before=2",
        "around=1&after=2",
        "around=1&before=2",
        "after=1&after=2",
        "q=text",
        "unknown=1",
    ],
)
def test_history_rejects_invalid_or_ambiguous_queries(conversation, query):
    e, alice, _, cid = conversation
    code, body = e.do("GET", f"/api/v1/channels/{cid}/history?{query}", alice)
    assert code == 400, body


def test_history_and_context_require_current_channel_access(conversation):
    e, alice, bob, cid = conversation
    carol, carol_id = e.user("carol")
    own = send(e, alice, cid, "private")
    assert e.do("GET", f"/api/v1/channels/{cid}/history")[0] == 401
    assert e.do("GET", f"/api/v1/channels/{cid}/history?around={own['id']}", carol)[0] == 404

    _, body = e.do("POST", "/api/v1/dms", alice, {"user_id": carol_id})
    other = send(e, alice, body["channel"]["id"], "other conversation")
    assert e.do("GET", f"/api/v1/channels/{cid}/history?around={other['id']}", bob)[0] == 404
    assert e.do("GET", f"/api/v1/channels/{cid}/history?around=9223372036854775807", bob)[0] == 404
    assert e.do("DELETE", f"/api/v1/messages/{own['id']}", alice)[0] == 200
    assert e.do("GET", f"/api/v1/channels/{cid}/history?around={own['id']}", bob)[0] == 404

    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "G", "members": [carol_id]})
    group = body["group"]
    history(e, carol, group["channel_id"])
    assert e.do("DELETE", f"/api/v1/groups/{group['id']}/members/{carol_id}", alice)[0] == 204
    assert e.do("GET", f"/api/v1/channels/{group['channel_id']}/history", carol)[0] == 404


def test_history_hydrates_a_window_and_only_its_needed_profiles(conversation):
    e, alice, bob, cid = conversation
    reactor, reactor_id = e.user("reactor")
    assert e.do("PATCH", "/api/v1/me", reactor, {"about": "reaction-only profile"})[0] == 200
    bob_id = e.do("GET", "/api/v1/me", bob)[1]["user"]["id"]
    _, group = e.do("POST", "/api/v1/groups", alice, {"name": "G", "members": [bob_id, reactor_id]})
    cid = group["group"]["channel_id"]
    original = send(e, alice, cid, "Original text")
    code, uploaded = e.upload(bob, "note.txt", b"A small attachment")
    assert code == 201, uploaded
    reply = send(e, bob, cid, "A reply", reply_to=original["id"], attachments=[uploaded["file"]["id"]])
    assert e.do("POST", f"/api/v1/messages/{reply['id']}/reactions", reactor, {"emoji": "👍"})[0] == 200
    assert e.do("POST", f"/api/v1/messages/{reply['id']}/pin", alice)[0] == 200
    page = history(e, bob, cid, around=reply["id"], limit=1)
    message = page["messages"][0]
    assert message["reply"]["text"] == "Original text"
    assert [f["id"] for f in message["attachments"]] == [uploaded["file"]["id"]]
    assert message["reactions"] == [{"emoji": "👍", "users": [reactor_id]}]
    assert message["pinned_at"] is not None
    assert {u["id"] for u in page["users"]} == {original["author_id"], reply["author_id"]}
    assert all("password_hash" not in u and "token" not in u for u in page["users"])

    assert e.do("DELETE", f"/api/v1/messages/{original['id']}", alice)[0] == 200
    page = history(e, bob, cid, around=reply["id"], limit=1)
    preview = page["messages"][0]["reply"]
    assert preview["deleted"] is True and preview["text"] == "" and preview["attachments"] == 0
    assert "Original text" not in json.dumps(page)


def test_history_versions_match_messages_and_change_events(conversation):
    e, alice, bob, cid = conversation
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": bob}))
        assert json.loads(ws.receive_text())["type"] == "hello"

        def receive(kind):
            while True:
                frame = json.loads(ws.receive_text())
                if frame["type"] == kind:
                    return frame["data"]

        first = send(e, alice, cid, "first", nonce="stable")
        created = receive("message.created")
        page = history(e, bob, cid)
        assert first["revision"] == created["revision"] == page["history_version"] == 1
        assert page["messages"][0] == first
        retry = send(e, alice, cid, "first", nonce="stable")
        assert retry == first
        assert history(e, bob, cid)["history_version"] == 1

        _, edited = e.do("PATCH", f"/api/v1/messages/{first['id']}", alice, {"text": "edited"})
        changed = receive("message.updated")
        assert edited["message"]["revision"] == changed["revision"] == 2
        assert history(e, bob, cid)["history_version"] == 2
        e.do("PATCH", f"/api/v1/messages/{first['id']}", alice, {"text": "edited"})
        assert history(e, bob, cid)["history_version"] == 2

        assert e.do("POST", f"/api/v1/messages/{first['id']}/pin", alice)[0] == 200
        assert history(e, bob, cid)["history_version"] == 3
        assert e.do("POST", f"/api/v1/messages/{first['id']}/pin", alice)[0] == 200
        assert history(e, bob, cid)["history_version"] == 3
        assert e.do("POST", f"/api/v1/messages/{first['id']}/reactions", bob, {"emoji": "👍"})[0] == 200
        assert history(e, bob, cid)["history_version"] == 4
        assert e.do("DELETE", f"/api/v1/messages/{first['id']}", alice)[0] == 200
        page = history(e, bob, cid)
        assert page["history_version"] == 5 and page["messages"] == []


def test_history_keeps_reply_hydration_in_the_same_snapshot(conversation, monkeypatch):
    e, alice, bob, cid = conversation
    original = send(e, alice, cid, "before")
    reply = send(e, bob, cid, "reply", reply_to=original["id"])
    hydrate = chat._hydrate

    async def race():
        reached = asyncio.Event()
        resume = asyncio.Event()
        blocked = False

        async def pause(messages, *args, **kwargs):
            nonlocal blocked
            task = asyncio.current_task()
            if task is not None and task.get_name() == "history-request" and not blocked:
                blocked = True
                reached.set()
                await resume.wait()
            return await hydrate(messages, *args, **kwargs)

        monkeypatch.setattr(chat, "_hydrate", pause)
        headers = {"Authorization": "Bearer " + alice}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            reading = asyncio.create_task(
                client.get(f"/api/v1/channels/{cid}/history?around={reply['id']}&limit=1", headers=headers),
                name="history-request",
            )
            tasks = [reading]
            try:
                await asyncio.wait_for(reached.wait(), 5)
                writing = asyncio.create_task(
                    client.patch(f"/api/v1/messages/{original['id']}", json={"text": "after"}, headers=headers)
                )
                tasks.append(writing)
                await asyncio.sleep(0.02)
                resume.set()
                page, changed = await asyncio.wait_for(asyncio.gather(*tasks), 5)
                assert page.status_code == changed.status_code == 200
                return page.json()
            finally:
                resume.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    page = e.c.portal.call(race)
    assert page["messages"][0]["reply"]["text"] == {2: "before", 3: "after"}[page["history_version"]]
    latest = history(e, bob, cid, around=reply["id"], limit=1)
    assert latest["history_version"] == 3
    assert latest["messages"][0]["reply"]["text"] == "after"


def test_history_default_window_is_bounded_in_a_large_conversation(conversation, monkeypatch):
    e, alice, bob, cid = conversation
    author = send(e, alice, cid, "seed")["author_id"]

    async def seed():
        async with in_transaction(db.CONN) as tx:
            for start in range(100_000 // 1000):
                await Message.bulk_create(
                    [
                        Message(
                            channel_id=cid,
                            author_id=author,
                            nonce=f"bulk-{start}-{i}",
                            text=f"m{start * 1000 + i}",
                            created_at=start * 1000 + i,
                        )
                        for i in range(1000)
                    ],
                    using_db=tx,
                )
        return await Message.filter(channel_id=cid).order_by("id").offset(50_000).first()

    middle = e.c.portal.call(seed)
    calls = []
    rows = db.rows

    async def record(query, values=None, c=None):
        result = await rows(query, values, c)
        calls.append((query, len(result)))
        return result

    monkeypatch.setattr(db, "rows", record)
    newest = history(e, bob, cid)
    assert len(newest["messages"]) == 100
    assert newest["messages"][-1]["text"] == "m99999"
    assert newest["has_before"] is True and newest["has_after"] is False
    newest_calls = len(calls)
    calls.clear()
    page = history(e, bob, cid, around=middle.id)
    assert len(page["messages"]) == 100 and middle.id in ids(page)
    assert page["has_before"] is True and page["has_after"] is True
    assert len(calls) <= newest_calls + 6
    assert len(calls) < 25
    assert all(count <= 200 for _, count in calls)
    assert all("OFFSET" not in query.upper() for query, _ in calls)


def test_new_history_is_advertised_without_changing_legacy_messages(conversation):
    e, alice, bob, cid = conversation
    first = send(e, alice, cid, "needle")
    second = send(e, alice, cid, "deleted needle")
    assert e.do("DELETE", f"/api/v1/messages/{second['id']}", alice)[0] == 200
    code, info = e.do("GET", "/api/v1/server")
    assert code == 200 and info["capabilities"]["history"] == 1
    code, legacy = e.do("GET", f"/api/v1/channels/{cid}/messages", bob)
    assert code == 200 and ids(legacy) == [first["id"], second["id"]]
    assert legacy["messages"][1]["deleted"] is True
    code, searched = e.do("GET", f"/api/v1/channels/{cid}/messages?q=needle", bob)
    assert code == 200 and ids(searched) == [first["id"]]
    assert ids(history(e, bob, cid)) == [first["id"]]


@pytest.mark.parametrize("change", ["edit", "delete"])
def test_channel_list_keeps_metadata_and_last_message_in_one_snapshot(conversation, monkeypatch, change):
    e, alice, bob, cid = conversation
    message = send(e, alice, cid, "before")
    messages_by_ids = chat.messages_by_ids

    def summary(body):
        channel = next(c for c in body["channels"] if c["id"] == cid)
        last = channel["last_message"]
        return {
            "history_version": channel["history_version"],
            "last_read_id": channel["last_read_id"],
            "unread": channel["unread"],
            "message_id": last["id"],
            "revision": last["revision"],
            "text": last["text"],
            "deleted": last["deleted"],
        }

    async def race():
        reached = asyncio.Event()
        resume = asyncio.Event()
        blocked = False

        async def pause(ids, *args, **kwargs):
            nonlocal blocked
            task = asyncio.current_task()
            if task is not None and task.get_name() == "channel-list-request" and not blocked:
                blocked = True
                # Metadata has been read, but the last message has not been fetched.
                reached.set()
                await resume.wait()
            return await messages_by_ids(ids, *args, **kwargs)

        monkeypatch.setattr(chat, "messages_by_ids", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            reading = asyncio.create_task(
                client.get("/api/v1/channels", headers={"Authorization": "Bearer " + bob}),
                name="channel-list-request",
            )
            tasks = [reading]
            try:
                await asyncio.wait_for(reached.wait(), 5)
                writing = asyncio.create_task(
                    client.request(
                        "PATCH" if change == "edit" else "DELETE",
                        f"/api/v1/messages/{message['id']}",
                        headers={"Authorization": "Bearer " + alice},
                        json={"text": "after"} if change == "edit" else None,
                    ),
                    name="channel-list-writer",
                )
                tasks.append(writing)
                # Let the independent writer commit while hydration is paused.
                # SQLite can instead serialize it behind the reader's transaction;
                # release that reader too, without requiring the writer to finish first.
                await asyncio.wait([writing], timeout=1)
                resume.set()
                listed, changed = await asyncio.wait_for(asyncio.gather(*tasks), 5)
                assert listed.status_code == changed.status_code == 200
                return listed.json()
            finally:
                resume.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    listed = e.c.portal.call(race)
    assert summary(listed) == {
        "history_version": 1,
        "last_read_id": 0,
        "unread": 1,
        "message_id": message["id"],
        "revision": 1,
        "text": "before",
        "deleted": False,
    }
    code, latest = e.do("GET", "/api/v1/channels", bob)
    assert code == 200, latest
    if change == "delete":
        channel = next(c for c in latest["channels"] if c["id"] == cid)
        assert channel["last_message"] is None
        assert channel["history_version"] == 2 and channel["unread"] == 0
        return
    assert summary(latest) == {
        "history_version": 2,
        "last_read_id": 0,
        "unread": 1 if change == "edit" else 0,
        "message_id": message["id"],
        "revision": 2,
        "text": "after" if change == "edit" else "",
        "deleted": change == "delete",
    }


def test_history_after_zero_starts_at_the_first_visible_message(conversation):
    e, alice, bob, cid = conversation
    messages = [send(e, alice, cid, str(i)) for i in range(12)]
    assert e.do("DELETE", f"/api/v1/messages/{messages[0]['id']}", alice)[0] == 200
    page = history(e, bob, cid, after=0, limit=3)
    assert ids(page) == [m["id"] for m in messages[1:4]]
    assert page["has_before"] is False and page["has_after"] is True
    assert ids(history(e, bob, cid, limit=3)) == [m["id"] for m in messages[-3:]]
