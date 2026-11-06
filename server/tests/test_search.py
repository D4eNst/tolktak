import asyncio
import json
from urllib.parse import urlencode
from uuid import uuid4

import httpx
import pytest
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.models import Message
from tolktak.store import chat, search


@pytest.fixture
def conversation(make_env):
    e = make_env()
    e.server.rl.disabled = True
    alice, alice_id = e.user("alice")
    bob, bob_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", alice, {"user_id": bob_id})
    return e, alice, alice_id, bob, bob_id, body["channel"]["id"]


def send(e, token, cid, text, **fields):
    code, body = e.do("POST", f"/api/v1/channels/{cid}/messages", token, {"text": text, "nonce": uuid4().hex, **fields})
    assert code == 200, body
    return body["message"]


def page(e, token, cid, query, **params):
    code, body = e.do("GET", f"/api/v1/channels/{cid}/search?{urlencode({'q': query, **params})}", token)
    assert code == 200, body
    return body


def test_search_pages_over_one_hundred_hits_in_descending_id_order(conversation):
    e, alice, _, bob, _, cid = conversation
    matches = [send(e, alice, cid, f"needle {i}")["id"] for i in range(125)]
    send(e, alice, cid, "does not match")
    first = page(e, bob, cid, "needle")
    assert [m["id"] for m in first["messages"]] == matches[-1:-51:-1]
    assert first["has_more"] is True and first["next_before"] == matches[-50]
    assert first["history_version"] == 126
    second = page(e, bob, cid, "needle", before=first["next_before"], limit=100)
    assert [m["id"] for m in second["messages"]] == list(reversed(matches[:75]))
    assert second["has_more"] is False and second["next_before"] is None
    exact = page(e, bob, cid, "needle", before=matches[50], limit=50)
    assert len(exact["messages"]) == 50 and exact["has_more"] is False
    assert e.do("GET", "/api/v1/server")[1]["capabilities"]["search"] == 1
    # Legacy search retains its response shape and request behaviour.
    legacy = e.do("GET", f"/api/v1/channels/{cid}/messages?q=needle&limit=100", bob)[1]
    assert list(legacy) == ["messages"] and len(legacy["messages"]) == 100


@pytest.mark.parametrize("query", ["прИвЕт", "ЁЖ", "STRASSE", "σς", "%_", "a_%b", "::", "[]", "a\\b", " x ", "a'\"b"])
def test_search_is_unicode_casefolded_literal_substring(conversation, query):
    e, alice, _, bob, _, cid = conversation
    text = "Привет Ёж Straße ΣΣ literal%_ a_%b :: [] a\\b prefix x suffix a'\"b"
    target = send(e, alice, cid, text)
    send(e, alice, cid, "aXYb aaab aZZZZb")
    result = page(e, bob, cid, query)
    assert [m["id"] for m in result["messages"]] == [target["id"]]
    assert result["messages"][0]["text"] == text


@pytest.mark.parametrize(
    "query",
    [
        "",
        "q=",
        "q=a",
        "q=" + "a" * 257,
        "q=abc&q=def",
        "q=abc&limit=0",
        "q=abc&limit=101",
        "q=abc&limit=1&limit=2",
        "q=abc&before=0",
        "q=abc&before=-1",
        "q=abc&before=+1",
        "q=abc&before=1.5",
        "q=abc&before=9223372036854775808",
        "q=abc&unknown=1",
        "q=%00x",
    ],
)
def test_search_rejects_invalid_queries(conversation, query):
    e, alice, _, _, _, cid = conversation
    assert e.do("GET", f"/api/v1/channels/{cid}/search?{query}", alice)[0] == 400


def test_search_maximum_query_and_short_fallback(conversation):
    e, alice, _, bob, _, cid = conversation
    text = "ΐ" * 256
    target = send(e, alice, cid, text)
    assert page(e, bob, cid, text)["messages"][0]["id"] == target["id"]
    assert page(e, bob, cid, "ΐΐ")["messages"][0]["id"] == target["id"]
    assert page(e, bob, cid, "xx")["messages"] == []


def test_search_access_cursor_scope_and_deleted_cursor(conversation):
    e, alice, _, bob, bob_id, cid = conversation
    carol, carol_id = e.user("carol")
    original = send(e, alice, cid, "needle first")
    last = send(e, alice, cid, "needle last")
    _, other = e.do("POST", "/api/v1/dms", alice, {"user_id": carol_id})
    foreign = send(e, alice, other["channel"]["id"], "needle secret")
    assert e.do("GET", f"/api/v1/channels/{cid}/search?q=needle")[0] == 401
    assert e.do("GET", f"/api/v1/channels/{cid}/search?q=needle", carol)[0] == 404
    assert e.do("GET", f"/api/v1/channels/{cid}/search?q=needle&before={foreign['id']}", bob)[0] == 404
    assert e.do("GET", f"/api/v1/channels/{cid}/search?q=needle&before=9223372036854775807", bob)[0] == 404
    assert e.do("DELETE", f"/api/v1/messages/{last['id']}", alice)[0] == 200
    assert [m["id"] for m in page(e, bob, cid, "needle", before=last["id"])["messages"]] == [original["id"]]
    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "G", "members": [bob_id]})
    group = body["group"]
    assert e.do("DELETE", f"/api/v1/groups/{group['id']}/members/{bob_id}", alice)[0] == 204
    assert e.do("GET", f"/api/v1/channels/{group['channel_id']}/search?q=needle", bob)[0] == 404


def test_search_edits_deletions_and_rollback_update_the_index_atomically(conversation, monkeypatch):
    e, alice, alice_id, bob, _, cid = conversation
    message = send(e, alice, cid, "oldneedle")
    path = f"/api/v1/messages/{message['id']}"
    assert e.do("PATCH", path, alice, {"text": "newneedle"})[0] == 200
    assert page(e, bob, cid, "oldneedle")["messages"] == []
    assert page(e, bob, cid, "newneedle")["messages"][0]["text"] == "newneedle"
    replace = search.replace

    async def fail(*args):
        await replace(*args)
        raise RuntimeError("rollback both message and index")

    monkeypatch.setattr(search, "replace", fail)
    with pytest.raises(RuntimeError, match="rollback both"):
        e.c.portal.call(chat.edit_message, message["id"], alice_id, "rolledback")
    assert page(e, bob, cid, "rolledback")["messages"] == []
    assert page(e, bob, cid, "newneedle")["history_version"] == 2
    assert e.do("DELETE", path, alice)[0] == 200
    assert page(e, bob, cid, "newneedle")["messages"] == []
    assert e.c.portal.call(db.rows, "SELECT * FROM message_search") == []


@pytest.mark.parametrize("collection", ["search?q=needle", "pins"])
def test_search_and_pins_hydrate_needed_profiles_and_one_snapshot(conversation, monkeypatch, collection):
    e, alice, alice_id, bob, bob_id, cid = conversation
    original = send(e, alice, cid, "original")
    fid = e.upload(bob, "note.txt", b"bytes")[1]["file"]["id"]
    reply = send(e, bob, cid, "needle reply", reply_to=original["id"], attachments=[fid])
    assert e.do("POST", f"/api/v1/messages/{reply['id']}/pin", alice)[0] == 200
    hydrate = chat._hydrate
    read_state = chat._history_head

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def checked_read(cid, uid, c):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "collection-reader":
                assert c is not None, "Access must be checked in the collection snapshot"
            return await read_state(cid, uid, c)

        async def pause(messages, c=None):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "collection-reader":
                reached.set()
                await resume.wait()
            return await hydrate(messages, c)

        monkeypatch.setattr(chat, "_history_head", checked_read)
        monkeypatch.setattr(chat, "_hydrate", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            reading = asyncio.create_task(
                client.get(f"/api/v1/channels/{cid}/{collection}", headers={"Authorization": "Bearer " + bob}),
                name="collection-reader",
            )
            await asyncio.wait_for(reached.wait(), 5)

            async def write():
                async with in_transaction(db.CONN) as tx:
                    await chat._lock_history(cid, tx)
                    revision = await chat._advance_history(cid, tx)
                    await db.execute(
                        "UPDATE messages SET text = 'after', revision = ? WHERE id = ?", [revision, original["id"]], tx
                    )
                    await search.replace(original["id"], "after", tx)
                    await db.execute("UPDATE users SET display_name = 'after' WHERE id = ?", [alice_id], tx)

            writing = asyncio.create_task(write())
            try:
                await asyncio.wait([writing], timeout=0.05)
                resume.set()
                response, _ = await asyncio.wait_for(asyncio.gather(reading, writing), 5)
                assert response.status_code == 200
                return response.json()
            finally:
                resume.set()
                for task in (reading, writing):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(reading, writing, return_exceptions=True)

    result = e.c.portal.call(race)
    assert result["history_version"] == 3
    assert result["messages"][0]["reply"]["text"] == "original"
    assert result["messages"][0]["reply"]["revision"] == 1
    assert result["messages"][0]["attachments"][0]["id"] == fid
    assert {u["id"] for u in result["users"]} == {alice_id, bob_id}
    assert next(u for u in result["users"] if u["id"] == alice_id)["display_name"] == "alice"
    assert all("password_hash" not in u for u in result["users"])
    latest = e.do("GET", f"/api/v1/channels/{cid}/{collection}", bob)[1]
    assert latest["history_version"] == 4
    assert latest["messages"][0]["reply"]["text"] == "after"
    assert next(u for u in latest["users"] if u["id"] == alice_id)["display_name"] == "after"


def test_index_plan_scopes_candidates_and_bounds_hydrated_results(conversation, monkeypatch):
    e, _, alice_id, bob, _, cid = conversation

    async def seed():
        async with in_transaction(db.CONN) as tx:
            await Message.bulk_create(
                [
                    Message(
                        channel_id=cid,
                        author_id=alice_id,
                        nonce=f"bulk-{i}",
                        text=f"Обычное сообщение {i}" + (" rare_token_%" if i % 100 == 0 else ""),
                        created_at=i,
                    )
                    for i in range(20_000)
                ],
                using_db=tx,
            )
            await search.backfill(tx)
            await tx.execute_query("ANALYZE")

    e.c.portal.call(seed)
    rows = db.rows
    calls = []

    async def record(query, values=None, c=None):
        result = await rows(query, values, c)
        calls.append((query, values, len(result)))
        return result

    monkeypatch.setattr(db, "rows", record)
    result = page(e, bob, cid, "rare_token_%", limit=100)
    assert len(result["messages"]) == 100 and result["has_more"] is True
    assert all("rare_token_%" in m["text"] for m in result["messages"])
    assert all(n <= 200 for _, _, n in calls)
    query, values, _ = next(call for call in calls if ("message_search_fts f" in call[0] or "s.folded LIKE" in call[0]))

    async def plan():
        prefix = "EXPLAIN (FORMAT JSON) " if db.is_postgres() else "EXPLAIN QUERY PLAN "
        return await rows(prefix + query, values)

    plan_text = json.dumps(e.c.portal.call(plan))
    if e.server.cfg.database_url:
        assert "message_search_trigram" in plan_text, plan_text
    else:
        assert "VIRTUAL TABLE INDEX" in plan_text, plan_text
    assert "OFFSET" not in query.upper()


@pytest.mark.parametrize("collection", ["search?q=needle", "pins"])
def test_collection_access_uses_its_snapshot_when_membership_is_revoked(conversation, monkeypatch, collection):
    e, alice, _, bob, bob_id, _ = conversation
    _, body = e.do("POST", "/api/v1/groups", alice, {"name": "G", "members": [bob_id]})
    group = body["group"]
    cid = group["channel_id"]
    message = send(e, alice, cid, "needle")
    assert e.do("POST", f"/api/v1/messages/{message['id']}/pin", alice)[0] == 200
    head = chat._history_head

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(cid, uid, c):
            version = await head(cid, uid, c)
            task = asyncio.current_task()
            if task is not None and task.get_name() == "authorized-reader":
                reached.set()
                await resume.wait()
            return version

        monkeypatch.setattr(chat, "_history_head", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            reading = asyncio.create_task(
                client.get(f"/api/v1/channels/{cid}/{collection}", headers={"Authorization": "Bearer " + bob}),
                name="authorized-reader",
            )
            await asyncio.wait_for(reached.wait(), 5)
            revoking = asyncio.create_task(
                client.delete(
                    f"/api/v1/groups/{group['id']}/members/{bob_id}", headers={"Authorization": "Bearer " + alice}
                )
            )
            try:
                await asyncio.wait([revoking], timeout=0.05)
                resume.set()
                response, revoked = await asyncio.wait_for(asyncio.gather(reading, revoking), 5)
                assert revoked.status_code == 204
                assert response.status_code == 200 and response.json()["history_version"] == 2
                assert response.json()["messages"][0]["id"] == message["id"]
            finally:
                resume.set()
                for task in (reading, revoking):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(reading, revoking, return_exceptions=True)

    e.c.portal.call(race)
    assert e.do("GET", f"/api/v1/channels/{cid}/{collection}", bob)[0] == 404
