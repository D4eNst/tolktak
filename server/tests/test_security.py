import json
import time

from conftest import decode_jwt, post_webhook

from tolktak import db
from tolktak.api import voice, ws
from tolktak.store import users


def record_removals(e) -> list[tuple[str, str]]:
    removed = []

    async def remove(room: str, identity: str) -> None:
        removed.append((room, identity))

    e.server.lk.remove_participant = remove
    return removed


def next_event_or_close(ws) -> tuple[str, int]:
    """Skips presence events; a socket that stays open gets the message the test sends next."""
    while True:
        msg = ws.receive()
        if msg["type"] == "websocket.close":
            return "closed", msg["code"]
        ev = json.loads(msg["text"])
        if ev["type"] not in ("hello", "presence"):
            return ev["type"], 0


def eventually(check, timeout: float = 2) -> bool:
    end = time.monotonic() + timeout
    while not check():
        if time.monotonic() > end:
            return False
        time.sleep(0.01)
    return True


def test_forwarded_for_uses_the_address_the_proxy_added(make_env):
    e = make_env(trust_proxy=True)
    codes = [
        e.c.post(
            "/api/v1/auth/register",
            json={"username": f"user{i}", "password": "password123"},
            headers={"X-Forwarded-For": f"10.9.8.{i}, 203.0.113.7"},
        ).status_code
        for i in range(8)
    ]
    assert 429 in codes, "addresses the client put in front of the proxy's must not reset the limit"


def test_login_attempts_are_limited_per_address(make_env):
    e = make_env()
    codes = [
        e.do("POST", "/api/v1/auth/login", body={"username": f"name{i}", "password": "wrong"})[0] for i in range(12)
    ]
    assert 429 in codes, "one address must not try names without limit"


def test_login_attempts_are_limited_per_account(make_env):
    e = make_env(trust_proxy=True)
    e.user("alice")
    codes = [
        e.c.post(
            "/api/v1/auth/login",
            json={"username": " " * i + "ALICE", "password": "wrong-password"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        ).status_code
        for i in range(12)
    ]
    assert 429 in codes, "spelling the name differently or changing address must not reset the account's limit"


def test_removed_member_is_kept_out_of_voice(make_env):
    e = make_env()
    a, _ = e.user("alice")
    b, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "G", "members": [b_id]})
    g = body["group"]
    _, join = e.do("POST", "/api/v1/voice/join", b, {"room_id": g["rooms"][0]["id"]})
    claims = decode_jwt(join["token"])
    assert claims["exp"] - claims["nbf"] <= 15 * 60, "a join token must not stay usable for hours after a removal"
    removed = record_removals(e)
    assert e.do("DELETE", f"/api/v1/groups/{g['id']}/members/{b_id}", a)[0] == 204
    room = join["room"]
    joined = {"event": "participant_joined", "room": {"name": room}, "participant": {"identity": str(b_id)}}
    assert post_webhook(e, json.dumps(joined).encode()) == 200
    assert b_id not in [m.user_id for m in e.server.hub.voice_members(room)]
    assert eventually(lambda: (room, str(b_id)) in removed), "a removed member who reconnects must be dropped"


def test_reconcile_drops_non_members_from_voice(make_env):
    e = make_env()
    a, a_id = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "G", "members": []})
    room = f"g{body['group']['id']}r{body['group']['rooms'][0]['id']}"

    async def list_rooms():
        return [{"name": room}]

    async def list_participants(_: str):
        return [{"identity": str(a_id)}, {"identity": str(b_id)}]

    e.server.lk.list_rooms = list_rooms
    e.server.lk.list_participants = list_participants
    removed = record_removals(e)
    e.c.portal.call(voice.reconcile_once, e.server)
    assert [m.user_id for m in e.server.hub.voice_members(room)] == [a_id]
    assert eventually(lambda: removed == [(room, str(b_id))])


def test_password_change_ends_other_sessions(make_env):
    e = make_env()
    t1, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/auth/login", body={"username": "alice", "password": "password123"})
    t2 = body["token"]
    _, body = e.do("POST", "/api/v1/dms", t1, {"user_id": b_id})
    cid = body["channel"]["id"]
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": t2}))
        new = {"old_password": "password123", "new_password": "password456"}
        assert e.do("POST", "/api/v1/me/password", t1, new)[0] == 204
        e.do("POST", f"/api/v1/channels/{cid}/messages", t1, {"text": "after", "nonce": "n1"})
        assert next_event_or_close(ws) == ("closed", 4001)
    assert e.do("GET", "/api/v1/me", t2)[0] == 401
    assert e.do("GET", "/api/v1/me", t1)[0] == 200, "the session that changed the password stays"


def test_logout_closes_the_sessions_websocket(make_env):
    e = make_env()
    a, _ = e.user("alice")
    b, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": b}))
        assert e.do("POST", "/api/v1/auth/logout", b)[0] == 204
        e.do("POST", f"/api/v1/channels/{cid}/messages", a, {"text": "after", "nonce": "n1"})
        assert next_event_or_close(ws) == ("closed", 4001)


def test_session_deleted_in_database_stops_working(make_env, monkeypatch):
    e = make_env()
    a, _ = e.user("alice")
    assert e.do("GET", "/api/v1/me", a)[0] == 200
    e.c.portal.call(db.execute, "DELETE FROM sessions")
    later = users.now() + 61_000
    monkeypatch.setattr(users, "now", lambda: later)
    assert e.do("GET", "/api/v1/me", a)[0] == 401


def test_websocket_of_a_deleted_session_closes(make_env, monkeypatch):
    monkeypatch.setattr(ws, "PING_EVERY", 0.05)
    e = make_env()
    a, _ = e.user("alice")
    with e.c.websocket_connect("/api/v1/ws") as sock:
        sock.send_text(json.dumps({"type": "auth", "token": a}))
        e.c.portal.call(db.execute, "DELETE FROM sessions")
        later = users.now() + 61_000
        monkeypatch.setattr(users, "now", lambda: later)
        for _ in range(100):
            msg = sock.receive()
            if msg["type"] == "websocket.close":
                break
        assert (msg["type"], msg.get("code")) == ("websocket.close", 4001)


def test_only_dm_members_can_ring(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    c, _ = e.user("carol")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    for action in ("ring", "decline", "cancel"):
        assert e.do("POST", f"/api/v1/calls/{cid}/{action}", c)[0] == 404, f"an outsider could {action} a call"
    codes = [e.do("POST", f"/api/v1/calls/{cid}/ring", a)[0] for _ in range(15)]
    assert codes[0] == 204 and 429 in codes, "ringing must be rate limited"


def test_group_creation_is_rate_limited(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    codes = [e.do("POST", "/api/v1/groups", a, {"name": f"spam {i}", "members": [b_id]})[0] for i in range(30)]
    assert codes[0] == 201 and 429 in codes, "one account must not flood others with groups"


def test_profile_updates_are_rate_limited(make_env):
    e = make_env()
    a, _ = e.user("alice")
    codes = [e.do("PATCH", "/api/v1/me", a, {"status": f"s{i}"})[0] for i in range(30)]
    assert codes[0] == 200 and 429 in codes, "every profile update is broadcast to all connected users"
