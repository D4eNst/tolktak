import json
import time

from conftest import decode_jwt, post_webhook

from tolktak.api import voice


def record_removals(e) -> list[tuple[str, str]]:
    removed = []

    async def remove(room: str, identity: str) -> None:
        removed.append((room, identity))

    e.server.lk.remove_participant = remove
    return removed


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
