import json

import pytest

from tolktak.realtime import Hub, event


def open_socket(e, socket, token, watched=True):
    auth = {"type": "auth", "token": token}
    if watched:
        auth["profile_scope"] = "watched"
    socket.send_text(json.dumps(auth))
    hello = json.loads(socket.receive_text())
    assert hello["type"] == "hello"
    return hello["data"]


def watch(socket, ids, request_id="watch"):
    socket.send_text(json.dumps({"type": "users.watch", "user_ids": ids, "request_id": request_id}))
    while True:
        frame = json.loads(socket.receive_text())
        if frame["type"] == "users.snapshot" and frame["data"].get("request_id") == request_id:
            return frame["data"]


def drain(e, socket, uid, label):
    async def marker():
        e.server.hub.send_to([uid], event("test.barrier", label))

    e.c.portal.call(marker)
    frames = []
    while True:
        frame = json.loads(socket.receive_text())
        if frame["type"] == "test.barrier" and frame["data"] == label:
            return frames
        frames.append(frame)


@pytest.fixture
def people(make_env):
    e = make_env()
    e.server.rl.disabled = True
    alice, alice_id = e.user("alice")
    bob, bob_id = e.user("bob")
    carol, carol_id = e.user("carol")
    return e, alice, alice_id, bob, bob_id, carol, carol_id


def test_watched_hello_snapshot_scope_replacement_and_live_online(people):
    e, alice, alice_id, bob, bob_id, carol, carol_id = people
    with e.c.websocket_connect("/api/v1/ws") as other, e.c.websocket_connect("/api/v1/ws") as socket:
        open_socket(e, other, bob)
        hello = open_socket(e, socket, alice)
        assert hello["profile_scope"] == "watched" and hello["online"] == [alice_id]
        snapshot = watch(socket, [bob_id, bob_id, 9223372036854775807])
        assert snapshot["user_ids"] == [bob_id, 9223372036854775807]
        assert [u["id"] for u in snapshot["users"]] == [bob_id]
        assert snapshot["users"][0]["online"] is True and snapshot["users"][0]["profile_revision"] == 0
        assert e.do("PATCH", "/api/v1/me", bob, {"status": "one"})[0] == 200
        assert e.do("PATCH", "/api/v1/me", carol, {"status": "hidden update"})[0] == 200
        frames = drain(e, socket, alice_id, "watched")
        updates = [f["data"] for f in frames if f["type"] == "user.updated"]
        assert [(u["id"], u["profile_revision"]) for u in updates] == [(bob_id, 1)]
        assert watch(socket, [], "empty")["users"] == []
        e.do("PATCH", "/api/v1/me", bob, {"status": "two"})
        e.do("PATCH", "/api/v1/me", alice, {"status": "self is implicit"})
        frames = drain(e, socket, alice_id, "empty-watch")
        assert [f["data"]["id"] for f in frames if f["type"] == "user.updated"] == [alice_id]
        # Watching limits pushed resources; every registered profile is still readable.
        profile = e.do("GET", f"/api/v1/users/{carol_id}", alice)[1]
        assert profile["user"]["status"] == "hidden update" and profile["user"]["online"] is False


def test_two_connections_have_independent_watch_lists_and_legacy_stays_compatible(people):
    e, alice, alice_id, bob, bob_id, carol, carol_id = people
    with (
        e.c.websocket_connect("/api/v1/ws") as first,
        e.c.websocket_connect("/api/v1/ws") as second,
        e.c.websocket_connect("/api/v1/ws") as legacy,
    ):
        open_socket(e, first, alice)
        open_socket(e, second, alice)
        assert open_socket(e, legacy, alice, watched=False)["profile_scope"] == "all"
        watch(first, [bob_id], "first")
        watch(second, [carol_id], "second")
        e.do("PATCH", "/api/v1/me", bob, {"status": "bob"})
        e.do("PATCH", "/api/v1/me", carol, {"status": "carol"})
        e.user("newcomer")
        a = drain(e, first, alice_id, "first-events")
        b = drain(e, second, alice_id, "second-events")
        old = drain(e, legacy, alice_id, "legacy-events")
        assert [f["data"]["id"] for f in a if f["type"] == "user.updated"] == [bob_id]
        assert [f["data"]["id"] for f in b if f["type"] == "user.updated"] == [carol_id]
        assert all(f["type"] != "user.created" for f in a + b)
        assert {f["data"]["id"] for f in old if f["type"] == "user.updated"} == {bob_id, carol_id}
        assert len([f for f in old if f["type"] == "user.created"]) == 1
        first.close()
        e.do("PATCH", "/api/v1/me", carol, {"status": "second tab remains"})
        b = drain(e, second, alice_id, "surviving-tab")
        assert any(f["type"] == "user.updated" and f["data"]["id"] == carol_id for f in b)
    with e.c.websocket_connect("/api/v1/ws") as reconnected:
        assert open_socket(e, reconnected, alice)["online"] == [alice_id]
        e.do("PATCH", "/api/v1/me", bob, {"status": "no restored watches"})
        assert not any(f["type"] == "user.updated" for f in drain(e, reconnected, alice_id, "reconnect"))


@pytest.mark.parametrize("ids", [[True], [1.5], ["1"], [0], [-1], [9223372036854775808], list(range(1, 502)), None])
def test_invalid_watch_rejects_the_frame_without_replacing_previous_scope(people, ids):
    e, alice, alice_id, bob, bob_id, _, _ = people
    with e.c.websocket_connect("/api/v1/ws") as socket:
        open_socket(e, socket, alice)
        watch(socket, [bob_id])
        socket.send_text(json.dumps({"type": "users.watch", "user_ids": ids}))
        while (frame := json.loads(socket.receive_text()))["type"] != "error":
            pass
        assert frame["data"]["code"] == "bad_watch"
        e.do("PATCH", "/api/v1/me", bob, {"status": "still watched"})
        assert any(
            f["type"] == "user.updated" and f["data"]["id"] == bob_id
            for f in drain(e, socket, alice_id, "after-invalid")
        )


def test_contact_events_reach_both_parties_and_retries_emit_nothing(people):
    e, alice, alice_id, bob, bob_id, _, _ = people
    with (
        e.c.websocket_connect("/api/v1/ws") as first,
        e.c.websocket_connect("/api/v1/ws") as second,
        e.c.websocket_connect("/api/v1/ws") as other,
    ):
        open_socket(e, first, alice)
        open_socket(e, second, alice)
        open_socket(e, other, bob, watched=False)
        sent = e.do("PUT", f"/api/v1/contacts/{bob_id}", alice)[1]
        assert e.do("PUT", f"/api/v1/contacts/{bob_id}", alice) == (200, sent)
        identity = {"request_id": sent["relation"]["request_id"]}
        removed = e.do("POST", f"/api/v1/contacts/{bob_id}/cancel", alice, identity)[1]
        assert e.do("POST", f"/api/v1/contacts/{bob_id}/cancel", alice, identity) == (200, removed)
        for index, socket in enumerate((first, second)):
            events = [
                frame["data"]
                for frame in drain(e, socket, alice_id, f"owner-{index}")
                if frame["type"] == "contact.changed"
            ]
            assert events == [sent, removed]
        peer = [frame["data"] for frame in drain(e, other, bob_id, "peer") if frame["type"] == "contact.changed"]
        assert [event["relation"]["state"] for event in peer] == ["incoming", "none"]
        assert [event["incoming_count"] for event in peer] == [1, 0]
        assert all(event["user_id"] == alice_id for event in peer)


def test_hub_presence_filters_watchers_and_cleans_up_bounded_connection_state():
    async def no_audience(room):
        return []

    hub = Hub(no_audience)
    first = hub.register(1, b"first", "watched")
    second = hub.register(1, b"second", "watched")
    legacy = hub.register(3, b"legacy")
    first.watched, second.watched = {2}, {4}

    def frames(conn):
        out = []
        while not conn.queue.empty():
            value = conn.queue.get_nowait()
            if value is not None:
                out.append(json.loads(value))
        return out

    for conn in (first, second, legacy):
        frames(conn)
    bob = hub.register(2, b"bob", "watched")
    assert frames(first) == [{"type": "presence", "data": {"user_id": 2, "online": True}}]
    assert frames(second) == []
    assert frames(legacy) == [{"type": "presence", "data": {"user_id": 2, "online": True}}]
    hub.unregister(bob)
    assert frames(first) == [{"type": "presence", "data": {"user_id": 2, "online": False}}]
    assert frames(second) == []
    hub.end_sessions(1, [b"first"])
    assert first.watched == set() and first.closed is True and second.watched == {4}
    hub.unregister(first)
    assert hub.is_online(1) is True
    hub.unregister(second)
    assert second.watched == set() and hub.is_online(1) is False
