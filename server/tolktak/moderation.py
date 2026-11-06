import asyncio
import logging
from typing import TYPE_CHECKING
from weakref import WeakValueDictionary

import httpx

from . import db
from .errors import ApiError, NotFound
from .livekit import LiveKitError
from .realtime import event
from .server import group_room_name, parse_room_name
from .store import moderation as store
from .store import now

if TYPE_CHECKING:
    from .api.signaling import SignalBridge
    from .server import Server

log = logging.getLogger("tolktak")


def allowed_all(uid: int) -> dict:
    return {
        "room_id": None,
        "user_id": uid,
        "rules": [],
        "allowed": dict.fromkeys(store.SOURCES, True),
        "moderation_version": 0,
        "call_id": None,
    }


class Moderation:
    def __init__(self, server: Server):
        self.s = server
        self.locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self.bridges: dict[str, dict[SignalBridge, int]] = {}

    def lock(self, room: str) -> asyncio.Lock:
        lock = self.locks.get(room)
        if lock is None:
            lock = self.locks[room] = asyncio.Lock()
        return lock

    async def room_name(self, rid: int) -> str:
        row = await store.room_info(rid, None, db.conn())
        return group_room_name(row["group_id"], rid)

    async def parts(self, room: str) -> list[dict]:
        try:
            return await self.s.lk.list_participants(room)
        except LiveKitError as exc:
            if exc.code == "not_found":
                return []
            raise

    async def current(self, room: str, uid: int, authorize: bool = True) -> dict:
        parsed = parse_room_name(room)
        if parsed is None:
            raise NotFound
        if parsed[0] == "dm":
            if uid not in await self.s.room_members(room):
                raise NotFound
            return allowed_all(uid)
        actual = await self.room_name(parsed[2])
        if actual != room:
            raise NotFound
        return await store.snapshot(parsed[2], uid, authorize)

    async def publish(self, room: str, uid: int, source: str, action: str) -> dict:
        permissions = await self.current(room, uid, False)
        audience = await self.s.room_audience(room)
        self.s.hub.send_to(
            [*audience, uid],
            event(
                "voice.moderation",
                {
                    "room_id": permissions["room_id"],
                    "user_id": uid,
                    "source": source,
                    "action": action,
                    "permissions": permissions,
                },
            ),
        )
        return permissions

    async def close_bridges(self, room: str, uid: int) -> None:
        for bridge, owner in list(self.bridges.get(room, {}).items()):
            if owner == uid:
                await bridge.close()

    async def apply(self, room: str, uid: int, parts: list[dict] | None = None) -> None:
        permissions = await self.current(room, uid, False)
        allowed = permissions["allowed"]
        if not allowed["entry"]:
            await self.close_bridges(room, uid)
            try:
                await self.s.lk.remove_participant(room, str(uid))
            except LiveKitError as exc:
                if exc.code != "not_found":
                    raise
            await self.s.hub.voice_leave(room, uid)
            return
        parts = await self.parts(room) if parts is None else parts
        if not any(p.get("identity") == str(uid) for p in parts):
            return
        person = next(p for p in parts if p.get("identity") == str(uid))
        permission = person.get("permission")
        expected = set()
        if allowed["microphone"]:
            expected.add("MICROPHONE")
        if allowed["camera"]:
            expected.add("CAMERA")
        if allowed["screen"]:
            expected.update(("SCREEN_SHARE", "SCREEN_SHARE_AUDIO"))
        actual = (
            set(
                (permission or {}).get("canPublishSources")
                or ("MICROPHONE", "CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO")
            )
            if (permission or {}).get("canPublish")
            else set()
        )
        matches = (
            permission is None
            and all(allowed.values())
            or permission is not None
            and (
                bool(permission.get("canPublish")) == bool(expected)
                and actual == expected
                and permission.get("canSubscribe") is True
                and permission.get("canPublishData") is True
            )
        )
        if not matches:
            try:
                await self.s.lk.update_permissions(room, str(uid), allowed)
            except LiveKitError as exc:
                if exc.code != "not_found":
                    raise
        flags = {}
        if not allowed["microphone"]:
            flags["muted"] = True
        if not allowed["camera"]:
            flags["camera"] = False
        if not allowed["screen"]:
            flags["screen"] = False
        if flags:
            await self.s.hub.voice_update(room, uid, **flags)

    async def refresh(self, room: str, parts: list[dict] | None = None) -> list[dict]:
        parsed = parse_room_name(room)
        if parsed is None or parsed[0] == "dm":
            return [] if parts is None else parts
        parts = await self.parts(room) if parts is None else parts
        active = True if parts else (None if self.bridges.get(room) else False)
        await self.observe(room, active, parts)
        return parts

    async def observe(self, room: str, active: bool | None = None, parts: list[dict] | None = None) -> None:
        parsed = parse_room_name(room)
        if parsed is None or parsed[0] != "group":
            return
        expired = await store.observe(parsed[2], active)
        for uid in {uid for uid, _ in expired}:
            try:
                await self.apply(room, uid, parts)
            except httpx.HTTPError, OSError, RuntimeError:
                log.debug("voice permission reconciliation deferred room=%s user=%d", room, uid)
        for uid, source in expired:
            await self.publish(room, uid, source, "clear")

    async def permissions(self, rid: int, uid: int) -> dict:
        room = await self.room_name(rid)
        async with self.lock(room):
            # Pure expiry is available even if the SFU is temporarily unreachable.
            info = await store.room_info(rid, uid, db.conn())
            if info["call_active"]:
                try:
                    await self.refresh(room)
                except httpx.HTTPError, OSError, RuntimeError:
                    pass
            await self.observe(room)
            return await store.snapshot(rid, uid)

    async def mutate(
        self,
        rid: int,
        actor: int,
        uid: int,
        source: str,
        action: str,
        duration: str | None = None,
        seconds: int | None = None,
    ) -> dict:
        if not (self.s.cfg.embedded_livekit or self.s.cfg.signaling_private):
            raise ApiError(
                503, "moderation_unavailable", "Private LiveKit signaling must be configured before moderation"
            )
        room = await self.room_name(rid)
        async with self.lock(room):
            # Authorize before making an SFU call or touching persistent policy.
            async with store._write(rid, actor, uid):
                pass
            try:
                parts = await self.refresh(room)
                if action == "off":
                    sources = {
                        "microphone": {"MICROPHONE"},
                        "camera": {"CAMERA"},
                        "screen": {"SCREEN_SHARE", "SCREEN_SHARE_AUDIO"},
                    }[source]
                    person = next((p for p in parts if p.get("identity") == str(uid)), None)
                    if person is None or not any(t.get("source") in sources for t in person.get("tracks") or []):
                        raise ApiError(404, "track_not_found", "The participant is not publishing this source")
                    await store.touch(rid, actor, uid)
                    allowed = (await self.current(room, uid, False))["allowed"]
                    await self.s.lk.update_permissions(room, str(uid), allowed | {source: False})
                    await self.s.lk.update_permissions(room, str(uid), allowed)
                    flag = {"microphone": "muted", "camera": "camera", "screen": "screen"}[source]
                    await self.s.hub.voice_update(room, uid, **{flag: source == "microphone"})
                else:
                    await store.change_rule(rid, actor, uid, source, duration, seconds)
                    await self.apply(room, uid, parts)
                result = await self.publish(room, uid, source, action)
                if action == "kick":
                    await self.refresh(room)
                return result
            except ApiError:
                raise
            except (httpx.HTTPError, OSError, RuntimeError) as exc:
                log.warning("voice moderation SFU failure room=%s user=%d kind=%s", room, uid, type(exc).__name__)
                raise ApiError(503, "voice_unavailable", "Voice moderation could not be applied; retry") from None

    async def expiry_loop(self) -> None:
        while True:
            await asyncio.sleep(1)
            due = await db.rows(
                "SELECT DISTINCT room_id FROM voice_rules WHERE expires_at IS NOT NULL AND expires_at <= ?", [now()]
            )
            for row in due:
                try:
                    room = await self.room_name(row["room_id"])
                    async with self.lock(room):
                        await self.refresh(room)
                except NotFound, httpx.HTTPError, OSError, RuntimeError:
                    log.debug("voice expiry reconciliation deferred room=%d", row["room_id"])
