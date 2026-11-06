import asyncio
import time
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from test_moderation import room_env as room_env
from test_moderation import rule_path
from test_profile_watch import drain, open_socket

from tolktak.api import signaling
from tolktak.store import groups, now
from tolktak.store import moderation as store


class Upstream:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.closed = False

    async def recv(self):
        return b"first signaling response"

    async def send(self, message):
        await self.queue.put(message)

    def __aiter__(self):
        return self

    async def __anext__(self):
        data = await self.queue.get()
        if data is None:
            raise StopAsyncIteration
        return data

    async def close(self, code=1000, reason=""):
        self.closed = True
        await self.queue.put(None)


def test_expiry_during_admission_restores_sfu_and_notifies_all_target_sessions(room_env, monkeypatch):
    e, owner, owner_id, _, _, peer, uid, _, gid, rid, sfu = room_env
    room = f"g{gid}r{rid}"
    code, before = e.do("PUT", rule_path(rid, uid, "camera"), owner, {"duration": "time", "seconds": 60})
    assert code == 200 and before["allowed"]["camera"] is False
    assert "CAMERA" not in sfu.participants[1]["permission"]["canPublishSources"]
    future = now() + 61000

    async def connect(*args, **kwargs):
        monkeypatch.setattr(store, "now", lambda: future)
        return Upstream()

    monkeypatch.setattr(signaling, "connect", connect)
    token = e.server.lk.join_token(str(owner_id), "", "", room, 600)
    with (
        e.c.websocket_connect("/api/v1/ws") as first,
        e.c.websocket_connect("/api/v1/ws") as second,
        e.c.websocket_connect("/api/v1/ws") as moderator,
    ):
        open_socket(e, first, peer)
        open_socket(e, second, peer)
        open_socket(e, moderator, owner)
        with e.c.websocket_connect("/rtc?" + urlencode({"access_token": token})) as socket:
            assert socket.receive_bytes() == b"first signaling response"
            for index, (client, viewer) in enumerate(((first, uid), (second, uid), (moderator, owner_id))):
                events = [
                    f["data"] for f in drain(e, client, viewer, f"expiry-{index}") if f["type"] == "voice.moderation"
                ]
                assert len(events) == 1
                assert (events[0]["action"], events[0]["source"], events[0]["user_id"]) == ("clear", "camera", uid)
                permissions = events[0]["permissions"]
                assert permissions["allowed"]["camera"] is True and permissions["rules"] == []
                assert permissions["moderation_version"] > before["moderation_version"]
            assert "CAMERA" in sfu.participants[1]["permission"]["canPublishSources"]
            assert not any(t["source"] == "CAMERA" for t in sfu.participants[1]["tracks"])
            e.c.portal.call(e.server.moderation.refresh, room)
            assert not any(f["type"] == "voice.moderation" for f in drain(e, first, uid, "no-duplicate-clear"))


def test_proxy_rewrites_stale_and_refreshed_grants_and_bridges_both_frame_types(room_env, monkeypatch):
    e, owner, _, _, _, peer, uid, _, gid, rid, _ = room_env
    room = f"g{gid}r{rid}"
    # Represents both a previously issued app token and an SFU-refreshed token with old rights.
    stale = e.server.lk.join_token(str(uid), "old", "", room, 600)
    assert e.do("PUT", rule_path(rid, uid), owner, {"duration": "permanent"})[0] == 200
    captured = []

    async def connect(uri, **kwargs):
        assert "access_token" not in uri and stale not in uri
        fresh = kwargs["additional_headers"]["Authorization"].removeprefix("Bearer ")
        captured.append(e.server.lk.verify(fresh))
        return Upstream()

    monkeypatch.setattr(signaling, "connect", connect)
    for path in ("/rtc", "/rtc/v1"):
        with e.c.websocket_connect(path + "?" + urlencode({"access_token": stale, "sdk": "js"})) as socket:
            assert socket.receive_bytes() == b"first signaling response"
            socket.send_bytes(b"binary offer")
            assert socket.receive_bytes() == b"binary offer"
            socket.send_text("text signaling")
            assert socket.receive_text() == "text signaling"
    assert len(captured) == 2
    assert all("microphone" not in c["video"]["canPublishSources"] for c in captured)
    assert all(c["sub"] == str(uid) and c["video"]["room"] == room for c in captured)


def test_entry_policy_denies_cached_tokens_before_upstream_connect(room_env, monkeypatch):
    e, owner, _, _, _, _, uid, _, gid, rid, _ = room_env
    token = e.server.lk.join_token(str(uid), "", "", f"g{gid}r{rid}", 600)
    assert e.do("POST", f"/api/v1/rooms/{rid}/participants/{uid}/kick", owner, {})[0] == 200

    async def forbidden(*args, **kwargs):
        pytest.fail("A denied admission reached the SFU")

    monkeypatch.setattr(signaling, "connect", forbidden)
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with e.c.websocket_connect("/rtc?" + urlencode({"access_token": token})):
            pass
    assert e.c.get("/rtc/validate", params={"access_token": token}).status_code == 403


def test_admission_rejects_expired_malformed_foreign_and_ambiguous_tokens(room_env):
    e, _, _, _, _, _, uid, outsider, gid, rid, _ = room_env
    outsider_id = e.do("GET", "/api/v1/me", outsider)[1]["user"]["id"]
    token = e.server.lk.join_token(str(uid), "", "", f"g{gid}r{rid}", 600)
    claims = e.server.lk.verify(token)
    invalid = [
        "broken",
        e.server.lk.sign(claims | {"exp": int(time.time()) - 1}),
        e.server.lk.sign(claims | {"sub": str(outsider_id)}),
        e.server.lk.sign({key: value for key, value in claims.items() if key != "exp"}),
    ]
    for value in invalid:
        assert e.c.get("/rtc/validate", params={"access_token": value}).status_code == 401
    assert e.c.get("/rtc/validate", params=[("access_token", token), ("access_token", token)]).status_code == 401
    assert e.c.get("/rtc/validate", params={"access_token": token, "publish": "identity-suffix"}).status_code == 401


async def test_signaling_access_scope_redacts_credentials_without_losing_admission_input():
    original = b"access_token=private-token&sdk=js&join_request=private-offer"
    scope = {"type": "websocket", "path": "/rtc", "query_string": original}

    async def app(received, receive, send):
        assert received["state"]["voice_query"] == original
        assert b"private-token" not in received["query_string"]
        token, pairs = signaling._query(received, {})
        assert token == "private-token" and ("sdk", "js") in pairs

    await signaling.SignalPrivacy(app)(scope, None, None)
    assert b"private-token" not in scope["query_string"]


@pytest.mark.parametrize("revoke", [False, True])
def test_admission_serializes_with_policy_and_rechecks_membership_after_handshake(room_env, monkeypatch, revoke):
    e, _, owner_id, _, _, _, uid, _, gid, rid, sfu = room_env

    async def race():
        reached, resume, disconnect = asyncio.Event(), asyncio.Event(), asyncio.Event()
        captured = []

        class PausedUpstream(Upstream):
            async def recv(self):
                reached.set()
                await resume.wait()
                return b"joined"

        async def connect(uri, **kwargs):
            captured.append(e.server.lk.verify(kwargs["additional_headers"]["Authorization"].removeprefix("Bearer ")))
            return PausedUpstream()

        class Socket:
            app = e.c.app
            headers = {}
            url = SimpleNamespace(path="/rtc")
            accepted = False
            closed = False

            def __init__(self):
                token = e.server.lk.join_token(str(uid), "", "", f"g{gid}r{rid}", 600)
                self.scope = {"query_string": urlencode({"access_token": token}).encode()}

            async def accept(self):
                self.accepted = True

            async def send_bytes(self, data):
                pass

            async def receive(self):
                await disconnect.wait()
                return {"type": "websocket.disconnect", "code": 1000}

            async def close(self, **kwargs):
                self.closed = True

        monkeypatch.setattr(signaling, "connect", connect)
        socket = Socket()
        admission = asyncio.create_task(signaling.signaling(socket))  # ty: ignore[invalid-argument-type]
        mutation = None
        try:
            await asyncio.wait_for(reached.wait(), 5)
            if revoke:
                await groups.remove_group_member(gid, uid, owner_id)
            else:
                mutation = asyncio.create_task(
                    e.server.moderation.mutate(rid, owner_id, uid, "microphone", "set", "permanent")
                )
                # Admission owns the room lock until the upstream handshake completes.
                await asyncio.sleep(0)
                assert not mutation.done()
            resume.set()
            if mutation is not None:
                result = await asyncio.wait_for(mutation, 5)
                assert result["allowed"]["microphone"] is False and socket.accepted
                assert not any(t["source"] == "MICROPHONE" for t in sfu.participants[1]["tracks"])
            else:
                await asyncio.wait_for(admission, 5)
                assert socket.closed and not socket.accepted
            assert len(captured) == 1
        finally:
            resume.set()
            disconnect.set()
            await asyncio.wait_for(admission, 5)
            if mutation is not None:
                await asyncio.gather(mutation, return_exceptions=True)

    e.c.portal.call(race)
