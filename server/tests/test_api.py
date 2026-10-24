import json

from conftest import TEST_SECRET, decode_jwt, err_code, post_webhook


def test_registration_modes(make_env):
    e = make_env("invite")
    admin, _ = e.user("admin")
    _, body = e.do("GET", "/api/v1/me", admin)
    assert body["user"]["is_admin"] is True, "first user must be admin"
    code, res = e.do("POST", "/api/v1/auth/register", body={"username": "bob", "password": "password123"})
    assert (code, err_code(res)) == (403, "invite_required")
    code, body = e.do("POST", "/api/v1/admin/invites", admin, {"max_uses": 1, "days": 1})
    assert code == 201
    inv = body["invite"]["code"]
    e.user("bob", inv)
    code, res = e.do(
        "POST", "/api/v1/auth/register", body={"username": "carol", "password": "password123", "invite": inv}
    )
    assert (code, err_code(res)) == (403, "invite_invalid"), "exhausted invite must fail"
    code, res = e.do("POST", "/api/v1/auth/login", body={"username": "bob", "password": "wrong-password"})
    assert (code, err_code(res)) == (401, "bad_credentials")
    code, _ = e.do("POST", "/api/v1/auth/login", body={"username": "BOB", "password": "password123"})
    assert code == 200, "login must be case-insensitive"
    code, _ = e.do("GET", "/api/v1/admin/invites")
    assert code == 401, "admin endpoints need auth"


def test_direct_messages_idempotent_and_private(make_env):
    e = make_env()
    a, _ = e.user("alice")
    b, b_id = e.user("bob")
    c, _ = e.user("carol")

    code, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    assert code == 200, body
    cid = body["channel"]["id"]
    path = f"/api/v1/channels/{cid}/messages"

    msg = {"text": "привет", "nonce": "n-1"}
    _, first = e.do("POST", path, a, msg)
    _, retry = e.do("POST", path, a, msg)
    assert first["message"]["id"] == retry["message"]["id"], "retry with the same nonce must not duplicate"
    _, lst = e.do("GET", path, b)
    assert len(lst["messages"]) == 1
    assert e.do("GET", path, c)[0] == 404, "outsider must not read DM"
    assert e.do("POST", path, c, {"text": "x", "nonce": "c"})[0] == 404, "outsider must not post"
    _, ch = e.do("GET", "/api/v1/channels", b)
    assert ch["channels"][0]["unread"] == 1
    mid = first["message"]["id"]
    e.do("POST", f"/api/v1/channels/{cid}/read", b, {"message_id": mid})
    _, ch = e.do("GET", "/api/v1/channels", b)
    assert ch["channels"][0]["unread"] == 0
    code, res = e.do("PATCH", f"/api/v1/messages/{mid}", b, {"text": "hack"})
    assert (code, err_code(res)) == (403, "not_own_message")
    assert e.do("DELETE", f"/api/v1/messages/{mid}", a)[0] == 200


def test_pagination_order(make_env):
    e = make_env()
    e.server.rl.disabled = True
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    for i in range(120):
        e.do("POST", f"/api/v1/channels/{cid}/messages", a, {"text": f"m{i}", "nonce": f"n{i}"})
    _, page = e.do("GET", f"/api/v1/channels/{cid}/messages?limit=50", a)
    msgs = page["messages"]
    assert len(msgs) == 50 and msgs[49]["text"] == "m119" and msgs[0]["text"] == "m70"
    oldest = msgs[0]["id"]
    _, page = e.do("GET", f"/api/v1/channels/{cid}/messages?limit=50&before={oldest}", a)
    assert page["messages"][49]["text"] == "m69"
    _, page = e.do("GET", f"/api/v1/channels/{cid}/messages?limit=100&after={oldest}", a)
    assert len(page["messages"]) == 49


def test_groups_rooms_and_voice_access(make_env):
    e = make_env()
    a, a_id = e.user("alice")
    b, b_id = e.user("bob")
    c, c_id = e.user("carol")

    code, body = e.do("POST", "/api/v1/groups", a, {"name": "Игровая", "members": [b_id]})
    assert code == 201, body
    g = body["group"]
    gid = g["id"]
    room_id = g["rooms"][0]["id"]

    code, body = e.do("POST", "/api/v1/voice/join", b, {"room_id": room_id})
    assert code == 200, body
    assert body["room"] == f"g{gid}r{room_id}"
    claims = decode_jwt(body["token"])
    assert claims["video"]["room"] == body["room"] and claims["video"]["roomJoin"] is True
    assert claims["sub"] == str(b_id)
    code, res = e.do("POST", "/api/v1/voice/join", c, {"room_id": room_id})
    assert (code, err_code(res)) == (404, "not_found")
    code, res = e.do("POST", f"/api/v1/groups/{gid}/rooms", b, {"name": "Кино"})
    assert (code, err_code(res)) == (403, "moderators_only")
    assert e.do("POST", f"/api/v1/groups/{gid}/rooms", a, {"name": "Кино"})[0] == 201
    assert e.do("POST", f"/api/v1/groups/{gid}/members", b, {"user_ids": [c_id]})[0] == 204
    _, gs = e.do("GET", "/api/v1/groups", c)
    assert len(gs["groups"]) == 1
    assert e.do("DELETE", f"/api/v1/groups/{gid}/members/{a_id}", a)[0] == 204
    _, gs = e.do("GET", "/api/v1/groups", b)
    assert gs["groups"][0]["owner_id"] == b_id, "ownership should pass to bob"


def test_websocket_events_and_webhook(make_env):
    e = make_env()
    a, _ = e.user("alice")
    b, b_id = e.user("bob")
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": b}))

        def read(want: str) -> dict:
            while True:
                ev = json.loads(ws.receive_text())
                if ev["type"] == want:
                    return ev

        read("hello")
        _, body = e.do("POST", "/api/v1/groups", a, {"name": "G", "members": [b_id]})
        g = body["group"]
        read("group.updated")
        room = f"g{g['id']}r{g['rooms'][0]['id']}"
        payload = json.dumps(
            {"event": "participant_joined", "room": {"name": room}, "participant": {"identity": str(b_id)}}
        ).encode()
        assert post_webhook(e, payload, "wrong-secret-wrong-secret-wrong-secret!!") == 401
        assert post_webhook(e, payload, TEST_SECRET) == 200
        members = read("voice.room")["data"]["members"]
        assert len(members) == 1 and members[0]["user_id"] == b_id
        e.do("POST", f"/api/v1/channels/{g['channel_id']}/messages", a, {"text": "го", "nonce": "x1"})
        assert read("message.created")["data"]["text"] == "го"


def test_websocket_rejects_bad_token(make_env):
    e = make_env()
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "tt_nope"}))
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4001


def test_message_rate_limit(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    codes = [
        e.do("POST", f"/api/v1/channels/{cid}/messages", a, {"text": "spam", "nonce": f"s{i}"})[0] for i in range(40)
    ]
    assert 429 in codes, "a burst of 40 messages must hit the rate limit"


def test_ids_of_deleted_groups_are_not_reused(make_env):
    """Clients cache messages by channel id: a new group must never get a deleted group's ids."""
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "Old", "members": [b_id]})
    old = body["group"]
    e.do("POST", f"/api/v1/channels/{old['channel_id']}/messages", a, {"text": "old", "nonce": "o1"})
    assert e.do("DELETE", f"/api/v1/groups/{old['id']}", a)[0] == 204
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "New", "members": [b_id]})
    new = body["group"]
    assert new["id"] != old["id"]
    assert new["channel_id"] != old["channel_id"]
    assert new["rooms"][0]["id"] != old["rooms"][0]["id"]
    _, msgs = e.do("GET", f"/api/v1/channels/{new['channel_id']}/messages", a)
    assert msgs["messages"] == []
