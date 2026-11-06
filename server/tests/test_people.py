import asyncio
from urllib.parse import urlencode

import httpx
import pytest
from contact_helpers import establish_contact
from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.models import User
from tolktak.store import users


@pytest.fixture
def people(make_env):
    e = make_env()
    e.server.rl.disabled = True
    alice, alice_id = e.user("alice")
    bob, bob_id = e.user("bob")
    carol, carol_id = e.user("carol")
    return e, alice, alice_id, bob, bob_id, carol, carol_id


def directory(e, token, **query):
    code, body = e.do("GET", "/api/v1/users/directory?" + urlencode(query), token)
    assert code == 200, body
    return body


async def seed_users(count):
    await User.bulk_create(
        [
            User(
                username=f"person{i:04}",
                display_name=f"Person {i:04}",
                password_hash="unused",
                color="#000000",
                created_at=i,
                username_folded=f"person{i:04}",
                display_name_folded=f"person {i:04}",
            )
            for i in range(count)
        ]
    )


def test_directory_browses_every_registered_user_in_stable_bounded_pages(people):
    e, alice, alice_id, _, bob_id, _, carol_id = people
    e.c.portal.call(seed_users, 123)
    e.c.portal.call(establish_contact, alice_id, bob_id)
    first = directory(e, alice)
    assert len(first["users"]) == 50 and first["has_more"] is True
    assert first["next_after"] == first["users"][-1]["id"]
    assert first["contact_ids"] == [bob_id] and first["contacts_version"] == 2
    all_ids = [u["id"] for u in first["users"]]
    second = directory(e, alice, after=first["next_after"], limit=100)
    all_ids += [u["id"] for u in second["users"]]
    assert len(all_ids) == 126 and all_ids == sorted(set(all_ids))
    assert all_ids[:3] == [alice_id, bob_id, carol_id]
    assert second["has_more"] is False and second["next_after"] is None
    assert second["contact_ids"] == []
    assert all("profile_revision" in u and isinstance(u["online"], bool) for u in first["users"])
    assert all(
        "password_hash" not in u and "contacts_version" not in u and "username_folded" not in u for u in first["users"]
    )
    assert e.do("GET", "/api/v1/users/directory")[0] == 401
    assert directory(e, alice, after=9223372036854775807)["users"] == []


@pytest.mark.parametrize("query", ["", "BoB", "прИвЕт", "STRASSE", "a_%b", "a\\b", "::", " x "])
def test_directory_matches_literal_casefolded_username_or_display_name(people, query):
    e, alice, _, bob, bob_id, _, _ = people
    assert e.do("PATCH", "/api/v1/me", bob, {"display_name": "ПрИвЕт Straße a_%b a\\b :: x suffix"})[0] == 200
    body = directory(e, alice, q=query)
    assert bob_id in [u["id"] for u in body["users"]]
    if query and query != "BoB":
        assert [u["id"] for u in body["users"]] == [bob_id]
    assert directory(e, alice, q="aXYZb")["users"] == []


@pytest.mark.parametrize(
    "query",
    [
        "q=a&q=b",
        "q=" + "x" * 257,
        "q=%00",
        "limit=0",
        "limit=101",
        "limit=1.5",
        "after=-1",
        "after=+1",
        "after=1.5",
        "after=9223372036854775808",
        "after=0&after=1",
        "unknown=1",
    ],
)
def test_directory_rejects_invalid_or_ambiguous_queries(people, query):
    e, alice, _, _, _, _, _ = people
    assert e.do("GET", "/api/v1/users/directory?" + query, alice)[0] == 400


def test_directory_exclusions_do_not_consume_page_capacity(people):
    e, alice, alice_id, _, _, _, _ = people
    e.c.portal.call(seed_users, 300)
    body = directory(e, alice, exclude=",".join(str(i) for i in range(1, 201)))
    assert [u["id"] for u in body["users"]] == list(range(201, 251))
    assert body["has_more"] is True and body["next_after"] == 250
    assert directory(e, alice)["users"][0]["id"] == alice_id


@pytest.mark.parametrize(
    "excluded",
    ["", "1,,2", "+1", "0", "-1", "1.5", "1,1", "1,01", "9223372036854775808", ",".join(str(i) for i in range(1, 202))],
)
def test_directory_rejects_malformed_or_oversized_exclusions(people, excluded):
    e, alice, _, _, _, _, _ = people
    assert e.do("GET", "/api/v1/users/directory?" + urlencode({"exclude": excluded}), alice)[0] == 400


def test_contacts_require_acceptance_and_remain_independent_of_dms(people):
    e, alice, alice_id, bob, bob_id, _, _ = people
    assert e.do("GET", "/api/v1/contacts", alice)[1]["users"] == []
    sent = e.do("PUT", f"/api/v1/contacts/{bob_id}", alice)[1]
    assert sent["relation"]["state"] == "outgoing" and sent["contact"] is False
    assert e.do("PUT", f"/api/v1/contacts/{bob_id}", alice) == (200, sent)
    assert e.do("GET", "/api/v1/contacts", bob)[1]["users"] == []
    _, opened = e.do("POST", "/api/v1/dms", bob, {"user_id": alice_id})
    cid = opened["channel"]["id"]
    assert (
        e.do("POST", f"/api/v1/channels/{cid}/messages", bob, {"text": "Hello stranger", "nonce": "stranger"})[0] == 200
    )
    identity = {"request_id": sent["relation"]["request_id"]}
    assert e.do("POST", f"/api/v1/contacts/{alice_id}/accept", bob, identity)[1]["contact"] is True
    removed = e.do("DELETE", f"/api/v1/contacts/{bob_id}", alice, identity)
    assert removed[0] == 200 and removed[1]["relation"]["state"] == "none"
    assert e.do("DELETE", f"/api/v1/contacts/{bob_id}", alice, identity) == removed
    assert cid in [c["id"] for c in e.do("GET", "/api/v1/channels", alice)[1]["channels"]]
    assert e.do("GET", f"/api/v1/channels/{cid}/history", alice)[1]["messages"][0]["text"] == "Hello stranger"


def test_contacts_page_is_bounded_and_profile_batch_is_not_n_plus_one(people, monkeypatch):
    e, alice, alice_id, _, _, _, _ = people
    e.c.portal.call(seed_users, 115)

    async def add():
        ids = [r["id"] for r in await db.rows("SELECT id FROM users WHERE id != ? ORDER BY id", [alice_id])]
        for uid in ids:
            await establish_contact(alice_id, uid)

    e.c.portal.call(add)
    first = e.do("GET", "/api/v1/contacts", alice)[1]
    assert len(first["users"]) == len(first["contact_ids"]) == 50
    second = e.do("GET", f"/api/v1/contacts?after={first['next_after']}&limit=100", alice)[1]
    assert len(second["users"]) == 67 and second["has_more"] is False
    assert second["contacts_version"] == 234
    rows, calls = db.rows, []

    async def record(query, values=None, c=None):
        result = await rows(query, values, c)
        calls.append((query, len(result)))
        return result

    monkeypatch.setattr(db, "rows", record)
    ids = first["contact_ids"] + second["contact_ids"][:49]
    code, body = e.do("POST", "/api/v1/users/profiles", alice, {"ids": ids + [9223372036854775807]})
    assert code == 200 and len(body["users"]) == 99
    assert body["contact_ids"] == sorted(ids)
    assert len(calls) <= 4 and all(n <= 100 for _, n in calls)
    assert e.do("POST", "/api/v1/users/profiles", alice, {"ids": []})[1]["users"] == []
    for bad in ([1] * 101, [True], [1.0], ["1"], [0], [-1]):
        assert e.do("POST", "/api/v1/users/profiles", alice, {"ids": bad})[0] == 400
    assert e.do("GET", "/api/v1/users/9223372036854775807", alice)[0] == 404
    assert e.do("GET", "/api/v1/contacts?q=person", alice)[0] == 200
    cors = e.c.options(
        "/api/v1/contacts/1", headers={"Origin": "http://localhost", "Access-Control-Request-Method": "PUT"}
    )
    assert "PUT" in cors.headers["access-control-allow-methods"]


def test_profile_revision_changes_only_with_visible_fields_and_normalization(people):
    e, alice, _, bob, bob_id, _, _ = people
    initial = e.do("GET", f"/api/v1/users/{bob_id}", alice)[1]["user"]
    assert initial["profile_revision"] == 0
    changed = e.do("PATCH", "/api/v1/me", bob, {"display_name": "Straße"})[1]["user"]
    assert changed["profile_revision"] == 1
    assert directory(e, alice, q="STRASSE")["users"][0]["id"] == bob_id
    assert e.do("PATCH", "/api/v1/me", bob, {"display_name": "Straße"})[1]["user"]["profile_revision"] == 1
    assert e.do("PATCH", "/api/v1/me", bob, {})[1]["user"]["profile_revision"] == 1
    assert e.do("PATCH", "/api/v1/me", bob, {"about": "new", "status": "here"})[1]["user"]["profile_revision"] == 2
    assert e.do("PUT", f"/api/v1/contacts/{bob_id}", alice)[0] == 200
    assert e.do("GET", f"/api/v1/users/{bob_id}", alice)[1]["user"]["profile_revision"] == 2


def test_directory_profile_membership_and_version_share_one_snapshot(people, monkeypatch):
    e, alice, alice_id, _, bob_id, _, _ = people
    contact_ids = users._relations

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(uid, ids, c):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "directory-reader":
                reached.set()
                await resume.wait()
            return await contact_ids(uid, ids, c)

        monkeypatch.setattr(users, "_relations", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            reading = asyncio.create_task(
                client.get("/api/v1/users/directory", headers={"Authorization": "Bearer " + alice}),
                name="directory-reader",
            )
            await asyncio.wait_for(reached.wait(), 5)

            async def change():
                async with in_transaction(db.CONN) as tx:
                    await db.execute("UPDATE users SET contacts_version = 1 WHERE id = ?", [alice_id], tx)
                    await db.execute(
                        "INSERT INTO contact_links (owner_id, peer_id, state, since, request_id) "
                        "VALUES (?, ?, 'contact', 1, 'snapshot-id'), (?, ?, 'contact', 1, 'snapshot-id')",
                        [alice_id, bob_id, bob_id, alice_id],
                        tx,
                    )
                    await db.execute(
                        "UPDATE users SET display_name = 'after', display_name_folded = 'after', profile_revision = 1 WHERE id = ?",
                        [bob_id],
                        tx,
                    )

            writing = asyncio.create_task(change())
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

    snapshot = e.c.portal.call(race)
    assert snapshot["contacts_version"] == 0 and snapshot["contact_ids"] == []
    bob = next(u for u in snapshot["users"] if u["id"] == bob_id)
    assert bob["display_name"] == "bob" and bob["profile_revision"] == 0
    current = directory(e, alice)
    assert current["contacts_version"] == 1 and current["contact_ids"] == [bob_id]
    assert next(u for u in current["users"] if u["id"] == bob_id)["profile_revision"] == 1


def test_concurrent_contact_and_profile_writes_serialize_without_losing_versions(people):
    e, alice, alice_id, bob, bob_id, _, _ = people

    async def race():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            headers = {"Authorization": "Bearer " + alice}
            put = await asyncio.wait_for(
                asyncio.gather(*[client.put(f"/api/v1/contacts/{bob_id}", headers=headers) for _ in range(2)]), 5
            )
            assert [r.json()["contacts_version"] for r in put] == [1, 1]
            identity = put[0].json()["relation"]["request_id"]
            deleted = await asyncio.wait_for(
                asyncio.gather(
                    *[
                        client.post(f"/api/v1/contacts/{bob_id}/cancel", headers=headers, json={"request_id": identity})
                        for _ in range(2)
                    ]
                ),
                5,
            )
            assert [r.json()["contacts_version"] for r in deleted] == [2, 2]
            mutual = await asyncio.wait_for(
                asyncio.gather(
                    client.put(f"/api/v1/contacts/{bob_id}", headers=headers),
                    client.put(f"/api/v1/contacts/{alice_id}", headers={"Authorization": "Bearer " + bob}),
                ),
                5,
            )
            assert sorted(r.status_code for r in mutual) == [200, 409]
            edits = await asyncio.wait_for(
                asyncio.gather(
                    *[client.patch("/api/v1/me", headers=headers, json={"status": f"revision {i}"}) for i in range(8)]
                ),
                5,
            )
            assert sorted(r.json()["user"]["profile_revision"] for r in edits) == list(range(1, 9))

    e.c.portal.call(race)


def test_foreign_key_cleanup_and_missing_batch_profiles(people):
    e, alice, alice_id, _, _, _, _ = people
    e.c.portal.call(seed_users, 2)

    async def remove():
        ids = [r["id"] for r in await db.rows("SELECT id FROM users WHERE username LIKE 'person%' ORDER BY id")]
        await establish_contact(alice_id, ids[0])
        await establish_contact(ids[0], ids[1])
        await User.filter(id=ids[0]).delete()
        return ids

    ids = e.c.portal.call(remove)
    assert e.c.portal.call(db.rows, "SELECT * FROM contact_links") == []
    body = e.do("POST", "/api/v1/users/profiles", alice, {"ids": ids})[1]
    assert [u["id"] for u in body["users"]] == [ids[1]] and body["contact_ids"] == []
