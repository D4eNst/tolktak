import asyncio
from uuid import UUID, uuid4

import httpx
import pytest
from test_people import people as people
from test_profile_watch import drain, open_socket

from tolktak import db
from tolktak.store import users


def mutate(e, token, uid, action, identity=None):
    method = "PUT" if action == "send" else ("DELETE" if action == "remove" else "POST")
    path = f"/api/v1/contacts/{uid}" + ("" if action in ("send", "remove") else "/" + action)
    return e.do(method, path, token, {"request_id": identity} if identity else None)


def summary(e, token):
    code, body = e.do("GET", "/api/v1/contacts/summary", token)
    assert code == 200, body
    return body


def relation(e, token, uid):
    code, body = e.do("GET", f"/api/v1/users/{uid}", token)
    assert code == 200, body
    return body["relation"]


def prepare(people, state):
    e, a, aid, b, bid, _, _ = people
    identity = str(uuid4())
    if state == "incoming":
        identity = mutate(e, b, aid, "send")[1]["relation"]["request_id"]
    elif state in ("outgoing", "contact"):
        identity = mutate(e, a, bid, "send")[1]["relation"]["request_id"]
        if state == "contact":
            assert mutate(e, b, aid, "accept", identity)[0] == 200
    return identity


MATRIX = {
    "none": {
        "send": ("outgoing", True),
        "accept": None,
        "decline": ("none", False),
        "cancel": ("none", False),
        "remove": ("none", False),
    },
    "outgoing": {
        "send": ("outgoing", False),
        "accept": None,
        "decline": None,
        "cancel": ("none", True),
        "remove": None,
    },
    "incoming": {"send": None, "accept": ("contact", True), "decline": ("none", True), "cancel": None, "remove": None},
    "contact": {
        "send": ("contact", False),
        "accept": ("contact", False),
        "decline": None,
        "cancel": None,
        "remove": ("none", True),
    },
}


@pytest.mark.parametrize("state", MATRIX)
@pytest.mark.parametrize("action", ["send", "accept", "decline", "cancel", "remove"])
def test_every_relation_action_cell_has_atomic_perspective_versions_and_counts(people, state, action):
    e, a, aid, b, bid, _, _ = people
    identity = prepare(people, state)
    before_a, before_b = summary(e, a), summary(e, b)
    code, body = mutate(e, a, bid, action, identity)
    expected = MATRIX[state][action]
    if expected is None:
        assert code == 409 and body["error"]["code"] == "contact_state"
        after = state
        changed = False
    else:
        after, changed = expected
        assert code == 200, body
        assert body["relation"]["state"] == after and body["contact"] == (after == "contact")
        if after != "none":
            UUID(body["relation"]["request_id"])
            if state != "none":
                assert body["relation"]["request_id"] == identity
        else:
            assert body["relation"] == {"state": "none", "request_id": None, "since": None}
    a_head, b_head = summary(e, a), summary(e, b)
    assert a_head["contacts_version"] == before_a["contacts_version"] + int(changed)
    assert b_head["contacts_version"] == before_b["contacts_version"] + int(changed)
    assert a_head["incoming_count"] == int(after == "incoming")
    assert b_head["incoming_count"] == int(after == "outgoing")
    direct, reverse = relation(e, a, bid), relation(e, b, aid)
    assert direct["state"] == after
    assert (
        reverse["state"]
        == {"none": "none", "contact": "contact", "incoming": "outgoing", "outgoing": "incoming"}[after]
    )
    if after != "none":
        assert direct["request_id"] == reverse["request_id"] and direct["since"] == reverse["since"]


@pytest.mark.parametrize("state", ["incoming", "outgoing", "contact"])
@pytest.mark.parametrize("action", ["accept", "decline", "cancel", "remove"])
def test_old_identity_cannot_modify_replacement_relation(people, state, action):
    e, a, aid, b, bid, _, _ = people
    old = mutate(e, a, bid, "send")[1]["relation"]["request_id"]
    assert mutate(e, a, bid, "cancel", old)[0] == 200
    prepare(people, state)
    before = relation(e, a, bid)
    a_head, b_head = summary(e, a), summary(e, b)
    assert before["request_id"] != old
    assert mutate(e, a, bid, action, old)[0] == 409
    assert relation(e, a, bid) == before and summary(e, a) == a_head and summary(e, b) == b_head


def test_crossed_requests_never_autoaccept_and_parallel_actions_do_not_deadlock(people):
    e, a, aid, b, bid, _, _ = people

    async def race():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as c:
            results = await asyncio.wait_for(
                asyncio.gather(
                    c.put(f"/api/v1/contacts/{bid}", headers={"Authorization": "Bearer " + a}),
                    c.put(f"/api/v1/contacts/{aid}", headers={"Authorization": "Bearer " + b}),
                ),
                5,
            )
            assert sorted(r.status_code for r in results) == [200, 409]
            return results

    result = e.c.portal.call(race)
    sender, receiver, peer = (a, b, aid) if result[0].status_code == 200 else (b, a, bid)
    sender_peer = bid if sender == a else aid
    identity = relation(e, sender, sender_peer)["request_id"]
    assert summary(e, receiver)["incoming_count"] == 1

    # Two sessions accepting one identity must count only one transition.
    async def accept_twice():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as c:
            return await asyncio.wait_for(
                asyncio.gather(
                    *[
                        c.post(
                            f"/api/v1/contacts/{peer}/accept",
                            headers={"Authorization": "Bearer " + receiver},
                            json={"request_id": identity},
                        )
                        for _ in range(2)
                    ]
                ),
                5,
            )

    accepted = e.c.portal.call(accept_twice)
    assert [r.status_code for r in accepted] == [200, 200]
    assert [r.json()["contacts_version"] for r in accepted] == [2, 2]
    assert summary(e, a) == summary(e, b) == {"contacts_version": 2, "incoming_count": 0}


def test_events_reach_every_session_of_both_participants_only(people):
    e, a, aid, b, bid, other, oid = people
    with (
        e.c.websocket_connect("/api/v1/ws") as a1,
        e.c.websocket_connect("/api/v1/ws") as a2,
        e.c.websocket_connect("/api/v1/ws") as b1,
        e.c.websocket_connect("/api/v1/ws") as b2,
        e.c.websocket_connect("/api/v1/ws") as outsider,
    ):
        for socket, token in ((a1, a), (a2, a), (b1, b), (b2, b), (outsider, other)):
            open_socket(e, socket, token)
        sent = mutate(e, a, bid, "send")[1]
        identity = sent["relation"]["request_id"]
        assert mutate(e, a, bid, "send")[1] == sent
        assert mutate(e, b, aid, "accept", identity)[0] == 200
        assert mutate(e, b, aid, "accept", identity)[0] == 200
        assert mutate(e, a, bid, "remove", identity)[0] == 200
        assert mutate(e, a, bid, "remove", identity)[0] == 200
        for index, (socket, viewer, peer, states) in enumerate(
            (
                (a1, aid, bid, ["outgoing", "contact", "none"]),
                (a2, aid, bid, ["outgoing", "contact", "none"]),
                (b1, bid, aid, ["incoming", "contact", "none"]),
                (b2, bid, aid, ["incoming", "contact", "none"]),
            )
        ):
            frames = [
                f["data"] for f in drain(e, socket, viewer, f"relations-{index}") if f["type"] == "contact.changed"
            ]
            assert [f["relation"]["state"] for f in frames] == states
            assert [f["contacts_version"] for f in frames] == [1, 2, 3]
            assert all(f["user_id"] == peer for f in frames)
        assert not any(f["type"] == "contact.changed" for f in drain(e, outsider, oid, "outsider"))


def test_api_action_bodies_and_relation_filters_are_strict(people):
    e, a, aid, _, bid, _, _ = people
    for action in ("accept", "decline", "cancel", "remove"):
        for body in (None, {}, {"request_id": None}, {"request_id": True}, {"request_id": 1}, {"request_id": ""}):
            method = "DELETE" if action == "remove" else "POST"
            suffix = "" if action == "remove" else "/" + action
            assert e.do(method, f"/api/v1/contacts/{bid}{suffix}", a, body)[0] == 400
    for query in ("relation=none", "relation=contact&relation=incoming", "limit=101", "q=" + ("x" * 257), "exclude=1"):
        assert e.do("GET", "/api/v1/contacts?" + query, a)[0] == 400
    assert e.do("PUT", f"/api/v1/contacts/{aid}", a)[0] == 400
    assert e.do("GET", "/api/v1/server")[1]["capabilities"]["contacts"] == 2


@pytest.mark.parametrize("opponent", ["cancel", "decline"])
def test_accept_racing_terminal_action_has_one_transition(people, opponent):
    e, a, aid, b, bid, _, _ = people
    identity = mutate(e, a, bid, "send")[1]["relation"]["request_id"]

    async def race():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as c:
            other_uid, other_token = (bid, a) if opponent == "cancel" else (aid, b)
            return await asyncio.wait_for(
                asyncio.gather(
                    c.post(
                        f"/api/v1/contacts/{aid}/accept",
                        headers={"Authorization": "Bearer " + b},
                        json={"request_id": identity},
                    ),
                    c.post(
                        f"/api/v1/contacts/{other_uid}/{opponent}",
                        headers={"Authorization": "Bearer " + other_token},
                        json={"request_id": identity},
                    ),
                ),
                5,
            )

    responses = e.c.portal.call(race)
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert summary(e, a) == summary(e, b) == {"contacts_version": 2, "incoming_count": 0}
    expected = "contact" if responses[0].status_code == 200 else "none"
    assert relation(e, a, bid)["state"] == relation(e, b, aid)["state"] == expected


def test_incoming_pagination_search_and_global_counter_are_bounded(people):
    from test_people import seed_users

    e, a, aid, _, _, _, _ = people
    e.c.portal.call(seed_users, 115)

    async def seed():
        ids = [row["id"] for row in await db.rows("SELECT id FROM users WHERE username LIKE 'person%' ORDER BY id")]
        for uid in ids:
            await users.change_contact(uid, aid, "send")

    e.c.portal.call(seed)
    first = e.do("GET", "/api/v1/contacts?relation=incoming&q=person&limit=100", a)[1]
    assert len(first["users"]) == len(first["relations"]) == 100 and first["contact_ids"] == [] and first["has_more"]
    assert first["incoming_count"] == 115
    second = e.do("GET", f"/api/v1/contacts?relation=incoming&after={first['next_after']}&limit=100", a)[1]
    assert len(second["users"]) == 15 and not second["has_more"] and second["incoming_count"] == 115
    assert first["contacts_version"] == second["contacts_version"] == 115
    assert e.do("GET", "/api/v1/contacts?relation=outgoing", a)[1]["users"] == []
    assert e.do("GET", "/api/v1/contacts?q=doesnotmatch", a)[1]["incoming_count"] == 115
    assert e.do("GET", "/api/v1/contacts", a)[1]["users"] == []


def test_mirror_identity_mismatch_is_detected_without_partial_changes(people):
    e, a, aid, b, bid, _, _ = people
    identity = mutate(e, a, bid, "send")[1]["relation"]["request_id"]
    e.c.portal.call(db.execute, "UPDATE contact_links SET request_id=? WHERE owner_id=?", [str(uuid4()), bid])
    before_a, before_b = summary(e, a), summary(e, b)
    assert mutate(e, b, aid, "accept", identity)[0] == 409
    assert summary(e, a) == before_a and summary(e, b) == before_b


def test_dialog_directory_search_is_scoped_to_own_chats_and_independent_of_contacts(people):
    e, alice, aid, bob, bid, carol, cid = people
    endpoint = "/api/v1/users/dialogs"
    assert e.do("GET", endpoint)[0] == 401
    assert e.do("GET", endpoint, alice)[1]["users"] == []
    assert e.do("POST", "/api/v1/dms", bob, {"user_id": cid})[0] in (200, 201)
    assert e.do("GET", endpoint, alice)[1]["users"] == []
    for target in (bid, cid):
        assert e.do("POST", "/api/v1/dms", alice, {"user_id": target})[0] in (200, 201)
    code, page = e.do("GET", endpoint + "?limit=1", alice)
    assert code == 200 and [u["id"] for u in page["users"]] == [bid] and page["has_more"]
    assert page["contact_ids"] == []
    tail = e.do("GET", endpoint + f"?after={bid}&limit=1", alice)[1]
    assert [u["id"] for u in tail["users"]] == [cid] and not tail["has_more"]
    assert e.do("PATCH", "/api/v1/me", bob, {"display_name": "Straße 100%_пример"})[0] == 200
    for query in ("STRASSE", "%_", "ПРИМЕР"):
        body = e.do("GET", endpoint + "?q=" + query, alice)[1]
        assert [u["id"] for u in body["users"]] == [bid]
    assert e.do("GET", endpoint + "?q=alice", alice)[1]["users"] == []
