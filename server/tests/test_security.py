import asyncio
import json
import time

import httpx
from conftest import decode_jwt, post_webhook

from tolktak import db, realtime
from tolktak.api import voice, ws
from tolktak.api.files import remove_old_unused_files
from tolktak.server import parse_room_name
from tolktak.sniff import image_size
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


def test_outsider_cannot_announce_voice_presence(make_env):
    e = make_env()
    a, _ = e.user("alice")
    c, c_id = e.user("carol")
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "G", "members": []})
    room = f"g{body['group']['id']}r{body['group']['rooms'][0]['id']}"
    dm = e.do("POST", "/api/v1/dms", a, {"user_id": c_id})[1]["channel"]["id"]
    with e.c.websocket_connect("/api/v1/ws") as member, e.c.websocket_connect("/api/v1/ws") as outsider:
        member.send_text(json.dumps({"type": "auth", "token": a}))
        assert json.loads(member.receive_text())["type"] == "hello"
        outsider.send_text(json.dumps({"type": "auth", "token": c}))
        outsider.send_text(json.dumps({"type": "voice.joined", "room": room}))
        outsider.send_text(json.dumps({"type": "typing", "channel_id": dm}))
        assert next_event_or_close(member) == ("typing", 0), "the group saw an outsider join its voice room"
    assert e.server.hub.voice_members(room) == []


def test_slow_websocket_is_dropped(make_env):
    e = make_env()
    a, a_id = e.user("alice")
    with e.c.websocket_connect("/api/v1/ws") as sock:
        sock.send_text(json.dumps({"type": "auth", "token": a}))
        assert json.loads(sock.receive_text())["type"] == "hello"

        def flood():
            for _ in range(realtime.SEND_QUEUE + 1):
                e.server.hub.send_to([a_id], realtime.event("ping"))

        e.c.portal.call(flood)
        assert next_event_or_close(sock) == ("closed", 4008)


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


def test_sessions_unused_for_90_days_end(make_env, monkeypatch):
    e = make_env()
    idle, _ = e.user("alice")
    used, _ = e.user("bob")
    assert e.do("GET", "/api/v1/me", idle)[0] == 200
    later = users.now() + 91 * 24 * 60 * 60 * 1000
    monkeypatch.setattr(users, "now", lambda: later)
    assert e.do("GET", "/api/v1/me", used)[0] == 200
    e.c.portal.call(users.delete_idle_sessions)
    assert e.do("GET", "/api/v1/me", idle)[0] == 401
    assert e.do("GET", "/api/v1/me", used)[0] == 200


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


def test_websocket_frames_are_rate_limited(make_env):
    e = make_env()
    a, _ = e.user("alice")
    b, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    with e.c.websocket_connect("/api/v1/ws") as receiver, e.c.websocket_connect("/api/v1/ws") as sender:
        receiver.send_text(json.dumps({"type": "auth", "token": b}))
        assert json.loads(receiver.receive_text())["type"] == "hello"
        sender.send_text(json.dumps({"type": "auth", "token": a}))
        for _ in range(60):
            sender.send_text(json.dumps({"type": "typing", "channel_id": cid}))
        # Once the budget has room again, this frame marks the end of the typing ones.
        time.sleep(0.3)
        sender.send_text(json.dumps({"type": "voice.joined", "room": f"dm{cid}"}))
        typing = 0
        while (ev := json.loads(receiver.receive_text()))["type"] != "voice.room":
            typing += ev["type"] == "typing"
    assert 20 <= typing <= 25, f"{typing} typing events reached the other user"


def test_room_names_have_one_spelling():
    assert parse_room_name("g1r2") == ("group", 1, 2)
    assert parse_room_name("dm3") == ("dm", 3, 0)
    for name in ("g+1r2", "g1r-2", "dm+3", "dm-3"):
        assert parse_room_name(name) is None, name


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


def test_search_is_rate_limited(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    path = f"/api/v1/channels/{body['channel']['id']}/messages?q=word"
    codes = [e.do("GET", path, a)[0] for _ in range(20)]
    assert codes[0] == 200 and 429 in codes, "a search reads every message of the chat"


def test_jpeg_size_scan_is_bounded(tmp_path):
    p = tmp_path / "x.jpg"
    p.write_bytes(b"\xff\xd8\xff\x00\x00\x00" + bytes(8 << 20))
    t = time.perf_counter()
    assert image_size(str(p), "image/jpeg") == (0, 0)
    assert time.perf_counter() - t < 0.05, "a crafted JPEG must not block the event loop"


def test_client_image_size_is_validated(make_env):
    e = make_env()
    a, _ = e.user("alice")
    webp = b"RIFF\x00\x00\x00\x00WEBPVP8 " + bytes(32)

    def upload(w: str, h: str) -> dict:
        params = {"name": "x.webp", "w": w, "h": h}
        r = e.c.post("/api/v1/files", params=params, content=webp, headers={"Authorization": "Bearer " + a})
        return r.json()["file"]

    f = upload("-5", "999999999")
    assert "width" not in f and "height" not in f, f"stored {f}"
    f = upload("640", "480")
    assert (f["width"], f["height"]) == (640, 480)


def test_request_bodies_are_capped_before_reading(make_env):
    e = make_env()
    big = b'{"username": "' + b"a" * (100 << 10) + b'"}'
    headers = {"Content-Type": "application/json"}
    assert e.c.post("/api/v1/auth/login", content=big, headers=headers).status_code == 413
    chunks = (big[i : i + 4096] for i in range(0, len(big), 4096))
    assert e.c.post("/api/v1/auth/login", content=chunks, headers=headers).status_code == 413
    assert e.c.post("/api/v1/livekit/webhook", content=bytes(2 << 20)).status_code == 413


def test_file_names_lose_hidden_characters(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, body = e.upload(a, "invoice\u202egpj.exe", b"MZ" + bytes(64))
    assert body["file"]["name"] == "invoicegpj.exe"
    _, body = e.upload(a, "line\nbreak\u2066.txt", b"text")
    assert body["file"]["name"] == "linebreak.txt"


PNG = b"\x89PNG\r\n\x1a\n" + bytes(64)


def test_attachments_are_deleted_with_their_message(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    gone = e.upload(a, "photo.png", PNG)[1]["file"]["id"]
    kept = e.upload(a, "me.png", PNG)[1]["file"]["id"]
    e.do("PATCH", "/api/v1/me", a, {"avatar": kept})
    msg = {"text": "", "nonce": "n1", "attachments": [gone, kept]}
    _, body = e.do("POST", f"/api/v1/channels/{cid}/messages", a, msg)
    assert e.do("DELETE", f"/api/v1/messages/{body['message']['id']}", a)[0] == 200
    assert e.c.get(f"/api/v1/files/{gone}").status_code == 404
    assert not (e.server.cfg.files_dir / gone).exists()
    assert e.c.get(f"/api/v1/files/{kept}").status_code == 200, "a file still used as a profile picture stays"


def test_attachments_are_deleted_with_their_chat_and_group(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, body = e.do("POST", "/api/v1/groups", a, {"name": "G", "members": []})
    g = body["group"]
    _, body = e.do("POST", f"/api/v1/groups/{g['id']}/channels", a, {"name": "second"})
    second = body["channel"]["id"]
    in_second = e.upload(a, "a.png", PNG)[1]["file"]["id"]
    in_main = e.upload(a, "b.png", PNG)[1]["file"]["id"]
    for cid, fid in ((second, in_second), (g["channel_id"], in_main)):
        e.do("POST", f"/api/v1/channels/{cid}/messages", a, {"text": "", "nonce": fid, "attachments": [fid]})
    assert e.do("DELETE", f"/api/v1/text-channels/{second}", a)[0] == 204
    assert e.c.get(f"/api/v1/files/{in_second}").status_code == 404
    assert e.c.get(f"/api/v1/files/{in_main}").status_code == 200
    assert e.do("DELETE", f"/api/v1/groups/{g['id']}", a)[0] == 204
    assert e.c.get(f"/api/v1/files/{in_main}").status_code == 404


def test_uploads_stop_at_the_users_quota(make_env):
    e = make_env(user_quota_bytes=100)
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    cid = body["channel"]["id"]
    code, body = e.upload(a, "one.png", PNG)
    assert code == 201
    code, res = e.upload(a, "two.png", PNG)
    assert (code, res["error"]["code"]) == (507, "quota_exceeded")
    msg = {"text": "", "nonce": "n1", "attachments": [body["file"]["id"]]}
    _, body = e.do("POST", f"/api/v1/channels/{cid}/messages", a, msg)
    e.do("DELETE", f"/api/v1/messages/{body['message']['id']}", a)
    assert e.upload(a, "two.png", PNG)[0] == 201, "deleting a message frees its files' space"


def test_parallel_uploads_share_the_quota(make_env):
    e = make_env(user_quota_bytes=100)
    a, _ = e.user("alice")

    async def chunks():
        for _ in range(6):
            await asyncio.sleep(0.01)
            yield b"x" * 10

    async def two_uploads():
        auth = {"Authorization": "Bearer " + a}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as c:
            sent = [c.post("/api/v1/files", params={"name": "a.bin"}, content=chunks(), headers=auth) for _ in range(2)]
            return sorted(r.status_code for r in await asyncio.gather(*sent))

    assert e.c.portal.call(two_uploads) == [201, 507]


def test_files_nothing_uses_are_removed_after_a_day(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    cid = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})[1]["channel"]["id"]
    replaced, avatar, sent, unsent = [e.upload(a, f"{n}.png", PNG)[1]["file"]["id"] for n in "abcd"]
    e.do("PATCH", "/api/v1/me", a, {"avatar": replaced})
    e.do("PATCH", "/api/v1/me", a, {"avatar": avatar})
    e.do("POST", f"/api/v1/channels/{cid}/messages", a, {"text": "", "nonce": "n1", "attachments": [sent]})
    fresh = e.upload(a, "e.png", PNG)[1]["file"]["id"]
    e.c.portal.call(db.execute, "UPDATE files SET created_at = 0 WHERE id != ?", [fresh])
    e.c.portal.call(remove_old_unused_files, e.server)
    for fid, code in ((replaced, 404), (unsent, 404), (avatar, 200), (sent, 200), (fresh, 200)):
        assert e.c.get(f"/api/v1/files/{fid}").status_code == code, fid
    assert not (e.server.cfg.files_dir / unsent).exists()


def test_concurrent_first_accounts_make_one_admin(make_env):
    e = make_env()

    async def register_both():
        return await asyncio.gather(
            users.create_user("alice", "Alice", "password123", ""), users.create_user("bob", "Bob", "password123", "")
        )

    made = e.c.portal.call(register_both)
    assert sorted(u["is_admin"] for u in made) == [False, True]


def test_reactions_are_emoji(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    _, body = e.do("POST", f"/api/v1/channels/{body['channel']['id']}/messages", a, {"text": "hi", "nonce": "n1"})
    path = f"/api/v1/messages/{body['message']['id']}/reactions"
    for text in ("SCAM", "visit x.co", "1", "\u202e", "2024\u20e3"):
        assert e.do("POST", path, a, {"emoji": text})[0] == 400, f"{text!r} is not a reaction"
    for emoji in ("👍", "❤️‍🔥", "1️⃣", "🇷🇺", "👍🏽"):
        assert e.do("POST", path, a, {"emoji": emoji})[0] == 200, emoji
