import asyncio
from copy import deepcopy

import httpx
import pytest
from test_profile_watch import drain, open_socket

from tolktak import db
from tolktak.store import groups, now
from tolktak.store import moderation as store


class SFU:
    def __init__(self, owner, peer):
        permission = {
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
            "canPublishSources": ["MICROPHONE", "CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"],
        }
        self.participants: list[dict] = [
            {
                "identity": str(uid),
                "permission": deepcopy(permission),
                "tracks": [{"source": source, "sid": f"{uid}-{source}"} for source in permission["canPublishSources"]],
            }
            for uid in (owner, peer)
        ]
        self.calls = []
        self.fail = False

    async def list_participants(self, room):
        return deepcopy(self.participants)

    async def update_permissions(self, room, identity, allowed):
        if self.fail:
            raise RuntimeError("synthetic SFU failure")
        self.calls.append((identity, dict(allowed)))
        for person in self.participants:
            if person["identity"] != identity:
                continue
            sources = []
            if allowed["microphone"]:
                sources.append("MICROPHONE")
            if allowed["camera"]:
                sources.append("CAMERA")
            if allowed["screen"]:
                sources += ["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]
            person["permission"] = {
                "canPublish": bool(sources),
                "canSubscribe": allowed["entry"],
                "canPublishData": allowed["entry"],
                "canPublishSources": sources,
            }
            person["tracks"] = [t for t in person["tracks"] if t["source"] in sources]
            return person
        return {}

    async def remove_participant(self, room, identity):
        if self.fail:
            raise RuntimeError("synthetic SFU failure")
        self.participants = [p for p in self.participants if p["identity"] != identity]


@pytest.fixture
def room_env(make_env):
    e = make_env(signaling_private=True)
    e.server.rl.disabled = True
    owner, owner_id = e.user("owner")
    mod, mod_id = e.user("moderator")
    peer, peer_id = e.user("peer")
    outsider, _ = e.user("outsider")
    _, body = e.do("POST", "/api/v1/groups", owner, {"name": "G", "members": [mod_id, peer_id]})
    group = body["group"]
    rid, gid = group["rooms"][0]["id"], group["id"]
    e.do("PUT", f"/api/v1/groups/{gid}/members/{mod_id}/role", owner, {"role": "mod"})
    sfu = SFU(owner_id, peer_id)
    e.server.lk.list_participants = sfu.list_participants
    e.server.lk.update_permissions = sfu.update_permissions
    e.server.lk.remove_participant = sfu.remove_participant
    return e, owner, owner_id, mod, mod_id, peer, peer_id, outsider, gid, rid, sfu


def rule_path(rid, uid, source="microphone"):
    return f"/api/v1/rooms/{rid}/moderation/{uid}/{source}"


def test_media_restriction_is_in_sfu_permissions_and_own_snapshot(room_env):
    e, owner, _, _, _, peer, uid, _, _, rid, sfu = room_env
    code, body = e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})
    assert code == 200 and body["allowed"]["microphone"] is False
    assert body["allowed"]["camera"] is True and len(body["rules"]) == 1
    assert all(t["source"] != "MICROPHONE" for t in sfu.participants[1]["tracks"])
    assert "MICROPHONE" not in sfu.participants[1]["permission"]["canPublishSources"]
    own = e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)
    assert own == (200, body)
    joined = e.do("POST", "/api/v1/voice/join", peer, {"room_id": rid})[1]
    assert joined["permissions"] == body
    assert "microphone" not in e.server.lk.verify(joined["token"])["video"]["canPublishSources"]
    replay = e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})[1]
    assert replay["moderation_version"] == body["moderation_version"]
    cleared = e.do("DELETE", rule_path(rid, uid), owner)[1]
    assert cleared["allowed"]["microphone"] is True and cleared["rules"] == []
    assert "MICROPHONE" in sfu.participants[1]["permission"]["canPublishSources"]
    # Clearing policy grants permission but does not recreate an unpublished track.
    assert all(t["source"] != "MICROPHONE" for t in sfu.participants[1]["tracks"])


@pytest.mark.parametrize("source", ["microphone", "camera", "screen"])
def test_force_off_unpublishes_only_present_sources_without_persisting_a_rule(room_env, source):
    e, owner, _, _, _, _, uid, _, _, rid, sfu = room_env
    path = f"/api/v1/rooms/{rid}/participants/{uid}/off"
    code, body = e.do("POST", path, owner, {"source": source})
    assert code == 200 and body["rules"] == [] and body["allowed"][source] is True
    assert sfu.calls[-2][1][source] is False and sfu.calls[-1][1][source] is True
    affected = {"microphone": {"MICROPHONE"}, "camera": {"CAMERA"}, "screen": {"SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}}[
        source
    ]
    assert not any(t["source"] in affected for t in sfu.participants[1]["tracks"])
    assert e.do("POST", path, owner, {"source": source})[0] == 404
    assert e.c.portal.call(db.rows, "SELECT * FROM voice_rules") == []


def test_kick_entry_call_policy_and_whole_room_empty_semantics(room_env):
    e, owner, _, _, _, peer, uid, _, _, rid, sfu = room_env
    code, kicked = e.do("POST", f"/api/v1/rooms/{rid}/participants/{uid}/kick", owner, {})
    assert code == 200 and kicked["allowed"]["entry"] is False
    assert all(p["identity"] != str(uid) for p in sfu.participants)
    assert e.do("POST", "/api/v1/voice/join", peer, {"room_id": rid})[0] == 403
    # Target disconnect alone does not end a call while the owner remains present.
    assert e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[1]["allowed"]["entry"] is False
    sfu.participants = []
    ended = e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[1]
    assert ended["allowed"]["entry"] is True and ended["call_id"] is None
    assert ended["moderation_version"] > kicked["moderation_version"]


def test_expiry_and_offline_permanent_rule_removal(room_env, monkeypatch):
    e, owner, _, _, _, peer, uid, _, _, rid, sfu = room_env
    e.do("PUT", rule_path(rid, uid, "camera"), owner, {"duration": "time", "seconds": 1})
    created = e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[1]
    assert created["rules"][0]["expires_at"] > now()
    future = now() + 2000
    monkeypatch.setattr(store, "now", lambda: future)
    expired = e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[1]
    assert expired["allowed"]["camera"] is True and expired["rules"] == []
    assert "CAMERA" in sfu.participants[1]["permission"]["canPublishSources"]
    e.do("PUT", rule_path(rid, uid, "screen"), owner, {"duration": "permanent"})
    sfu.participants = sfu.participants[:1]
    listing = e.do("GET", f"/api/v1/rooms/{rid}/moderation", owner)[1]
    assert [r["source"] for r in listing["rules"]] == ["screen"]
    assert e.do("DELETE", rule_path(rid, uid, "screen"), owner)[1]["rules"] == []


def test_background_expiry_restores_sfu_and_notifies_target_without_http_refresh(room_env, monkeypatch):
    from tolktak import moderation

    e, owner, _, _, _, peer, uid, _, _, rid, sfu = room_env
    with e.c.websocket_connect("/api/v1/ws") as socket:
        open_socket(e, socket, peer)
        assert e.do("PUT", rule_path(rid, uid, "camera"), owner, {"duration": "time", "seconds": 1})[0] == 200
        drain(e, socket, uid, "before-expiry")
        future = now() + 2000
        monkeypatch.setattr(store, "now", lambda: future)
        monkeypatch.setattr(moderation, "now", lambda: future)
        notified = asyncio.Event()
        original = e.server.hub.send_to

        def record(audience, frame):
            import orjson

            data = orjson.loads(frame)
            if data["type"] == "voice.moderation" and data["data"]["action"] == "clear":
                notified.set()
            original(audience, frame)

        monkeypatch.setattr(e.server.hub, "send_to", record)

        async def wait_expired():
            await asyncio.wait_for(notified.wait(), 4)

        e.c.portal.call(wait_expired)
        events = [f["data"] for f in drain(e, socket, uid, "after-expiry") if f["type"] == "voice.moderation"]
        assert len(events) == 1 and events[0]["action"] == "clear"
        assert events[0]["permissions"]["allowed"]["camera"] is True
        assert "CAMERA" in sfu.participants[1]["permission"]["canPublishSources"]


def test_hierarchy_access_duration_validation_and_unavailable_effect(room_env):
    e, owner, owner_id, mod, mod_id, peer, uid, outsider, _, rid, sfu = room_env
    assert e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[0] == 200
    assert e.do("GET", f"/api/v1/rooms/{rid}/moderation", peer)[0] == 403
    assert e.do("GET", f"/api/v1/rooms/{rid}/moderation", outsider)[0] == 404
    assert e.do("PUT", rule_path(rid, owner_id), mod, {"duration": "permanent"})[0] == 403
    assert e.do("PUT", rule_path(rid, mod_id), mod, {"duration": "permanent"})[0] == 400
    assert e.do("PUT", rule_path(rid, uid), peer, {"duration": "permanent"})[0] == 400
    for body in (
        {},
        {"duration": "time"},
        {"duration": "time", "seconds": True},
        {"duration": "time", "seconds": 0},
        {"duration": "time", "seconds": 31536001},
        {"duration": "permanent", "seconds": 1},
    ):
        assert e.do("PUT", rule_path(rid, uid), owner, body)[0] == 400
    assert e.do("PUT", rule_path(rid, uid, "entry"), owner, {"duration": "permanent"})[0] == 400
    sfu.fail = True
    code, body = e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})
    assert code == 503 and body["error"]["code"] == "voice_unavailable"
    assert e.do("GET", f"/api/v1/rooms/{rid}/permissions", peer)[1]["allowed"]["microphone"] is False


def test_events_include_full_permissions_and_scope_to_room_audience_and_target(room_env):
    e, owner, owner_id, _, _, peer, uid, outsider, _, rid, _ = room_env
    outsider_id = e.do("GET", "/api/v1/me", outsider)[1]["user"]["id"]
    with (
        e.c.websocket_connect("/api/v1/ws") as target_ws,
        e.c.websocket_connect("/api/v1/ws") as owner_ws,
        e.c.websocket_connect("/api/v1/ws") as outside_ws,
    ):
        open_socket(e, target_ws, peer)
        open_socket(e, owner_ws, owner)
        open_socket(e, outside_ws, outsider)
        e.do("POST", f"/api/v1/rooms/{rid}/participants/{uid}/off", owner, {"source": "camera"})
        for socket, viewer in ((target_ws, uid), (owner_ws, owner_id)):
            data = [f["data"] for f in drain(e, socket, viewer, f"off-{viewer}") if f["type"] == "voice.moderation"]
            assert len(data) == 1 and data[0]["action"] == "off" and data[0]["source"] == "camera"
            assert data[0]["permissions"]["allowed"]["camera"] is True
        assert not any(f["type"] == "voice.moderation" for f in drain(e, outside_ws, outsider_id, "outside"))


def test_rule_pages_are_bounded_and_foreign_cursor_cannot_expose_another_room(room_env):
    e, owner, owner_id, _, _, _, uid, _, gid, rid, _ = room_env

    async def seed():
        from tolktak.models import User

        for number in range(34):
            target = await User.create(
                username=f"paged{number}",
                display_name=f"Paged {number}",
                password_hash="unused",
                color="#000000",
                created_at=1,
            )
            await groups.add_group_members(gid, [target.id], owner_id)
            for source in ("microphone", "camera", "screen"):
                await store.change_rule(rid, owner_id, target.id, source, "permanent")

    e.c.portal.call(seed)
    first = e.do("GET", f"/api/v1/rooms/{rid}/moderation", owner)[1]
    assert len(first["rules"]) == 100 and first["has_more"]
    assert len(first["users"]) <= 101 and all("online" in user for user in first["users"])
    second = e.do("GET", f"/api/v1/rooms/{rid}/moderation?after={first['next_after']}", owner)[1]
    assert len(second["rules"]) == 2 and not second["has_more"] and second["next_after"] is None
    ids = [r["id"] for r in first["rules"] + second["rules"]]
    assert ids == sorted(set(ids)) and first["moderation_version"] == second["moderation_version"]
    other = e.do("POST", "/api/v1/groups", owner, {"name": "Other", "members": [uid]})[1]["group"]["rooms"][0]["id"]
    assert e.do("GET", f"/api/v1/rooms/{other}/moderation?after={first['next_after']}", owner)[1]["rules"] == []
    for query in ("after=-1", "after=1.5", "after=", "after=0&after=1", "limit=0", "limit=101", "q=x"):
        assert e.do("GET", f"/api/v1/rooms/{rid}/moderation?{query}", owner)[0] == 400


def test_room_and_user_deletion_cascade_policies(room_env):
    e, owner, owner_id, _, mod_id, _, uid, _, _, rid, _ = room_env
    assert e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})[0] == 200

    async def cleanup():
        await db.execute("DELETE FROM users WHERE id = ?", [uid])
        assert await db.rows("SELECT * FROM voice_rules") == []
        # The independent room foreign key also cascades.
        await store.change_rule(rid, owner_id, mod_id, "camera", "permanent")
        await db.execute("DELETE FROM rooms WHERE id = ?", [rid])
        assert await db.rows("SELECT * FROM voice_rules") == []

    e.c.portal.call(cleanup)


def test_unsafe_manual_signaling_does_not_advertise_or_accept_moderation(make_env):
    e = make_env(livekit_public_url="ws://unsafe-direct-sfu:7880")
    e.server.rl.disabled = True
    owner, _ = e.user("owner")
    peer, uid = e.user("peer")
    _, body = e.do("POST", "/api/v1/groups", owner, {"name": "G", "members": [uid]})
    rid = body["group"]["rooms"][0]["id"]
    info = e.do("GET", "/api/v1/server")[1]
    assert "moderation" not in info["capabilities"]
    assert "unsafe-direct-sfu" not in info["livekit_url"]
    code, body = e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})
    assert code == 503 and body["error"]["code"] == "moderation_unavailable"
    assert e.c.portal.call(db.rows, "SELECT * FROM voice_rules") == []


def test_role_revocation_during_sfu_lookup_prevents_the_policy_write(room_env, monkeypatch):
    e, owner, owner_id, mod, mod_id, _, uid, _, gid, rid, sfu = room_env
    lookup = sfu.list_participants

    async def race():
        reached, resume = asyncio.Event(), asyncio.Event()

        async def pause(room):
            task = asyncio.current_task()
            if task is not None and task.get_name() == "moderation-write":
                reached.set()
                await resume.wait()
            return await lookup(room)

        monkeypatch.setattr(e.server.lk, "list_participants", pause)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=e.c.app), base_url="http://test") as client:
            writing = asyncio.create_task(
                client.put(
                    rule_path(rid, uid), json={"duration": "permanent"}, headers={"Authorization": "Bearer " + mod}
                ),
                name="moderation-write",
            )
            try:
                await asyncio.wait_for(reached.wait(), 5)
                await groups.set_group_role(gid, mod_id, "member", owner_id)
                resume.set()
                response = await asyncio.wait_for(writing, 5)
                assert response.status_code == 403
            finally:
                resume.set()
                if not writing.done():
                    writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)

    e.c.portal.call(race)
    assert e.c.portal.call(db.rows, "SELECT * FROM voice_rules") == []
