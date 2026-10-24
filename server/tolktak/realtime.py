"""Runs only on the event loop, so no locks are needed."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Collection
from dataclasses import asdict, dataclass

import orjson

log = logging.getLogger("tolktak")

SEND_QUEUE = 512


def event(type_: str, data=None) -> bytes:
    return orjson.dumps({"type": type_} if data is None else {"type": type_, "data": data})


class Conn:
    def __init__(self, user_id: int, session: bytes):
        self.user_id = user_id
        self.session = session
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(SEND_QUEUE)
        self.closed = False
        # Set by the hub when the connection cannot keep up.
        self.kicked = False
        # Set by the hub when the session has ended.
        self.revoked = False

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            # Wake the writer: a drain or kick always leaves room.
            try:
                self.queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    def drop(self) -> None:
        """Closes without sending what is still queued."""
        self.closed = True
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)


@dataclass
class VoiceMember:
    user_id: int
    muted: bool = False
    deafened: bool = False
    camera: bool = False
    screen: bool = False
    joined_at: int = 0


# Returns the users allowed to observe a voice room.
AudienceFunc = Callable[[str], Awaitable[list[int]]]


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


class Hub:
    def __init__(self, audience: AudienceFunc):
        self.conns: dict[int, set[Conn]] = {}
        self.voice: dict[str, dict[int, VoiceMember]] = {}
        self.audience = audience

    def register(self, user_id: int, session: bytes) -> Conn:
        c = Conn(user_id, session)
        first = not self.conns.get(user_id)
        self.conns.setdefault(user_id, set()).add(c)
        if first:
            self.broadcast_all(event("presence", {"user_id": user_id, "online": True}))
        return c

    def unregister(self, c: Conn) -> None:
        conns = self.conns.get(c.user_id, set())
        conns.discard(c)
        last = not conns
        if last:
            self.conns.pop(c.user_id, None)
        c.close()
        if last:
            self.broadcast_all(event("presence", {"user_id": c.user_id, "online": False}))

    def end_sessions(self, uid: int, sessions: Collection[bytes]) -> None:
        for c in list(self.conns.get(uid, ())):
            if c.session in sessions:
                c.revoked = True
                c.drop()

    def online(self) -> list[int]:
        return sorted(self.conns)

    def is_online(self, uid: int) -> bool:
        return bool(self.conns.get(uid))

    def _deliver(self, uid: int, b: bytes) -> None:
        for c in list(self.conns.get(uid, ())):
            if c.closed:
                continue
            try:
                c.queue.put_nowait(b)
            except asyncio.QueueFull:
                # Slow consumer: the client reconnects and resyncs.
                log.warning("dropping slow websocket user=%d", uid)
                c.kicked = True
                c.drop()

    def send_to(self, users, b: bytes) -> None:
        for u in set(users):
            self._deliver(u, b)

    def broadcast_all(self, b: bytes) -> None:
        for u in list(self.conns):
            self._deliver(u, b)

    def _snapshot(self, room: str) -> dict:
        members = sorted(self.voice.get(room, {}).values(), key=lambda m: m.joined_at)
        return {"room": room, "members": [asdict(m) for m in members]}

    async def publish_room(self, room: str) -> None:
        audience = await self.audience(room)
        self.send_to(audience, event("voice.room", self._snapshot(room)))

    async def voice_join(self, room: str, uid: int) -> None:
        left = []
        for r, members in list(self.voice.items()):
            if r != room and uid in members:
                del members[uid]
                left.append(r)
                if not members:
                    del self.voice[r]
        members = self.voice.setdefault(room, {})
        changed = uid not in members
        if changed:
            members[uid] = VoiceMember(user_id=uid, joined_at=_now_ms())
        for r in left:
            await self.publish_room(r)
        if changed:
            await self.publish_room(room)

    async def voice_leave(self, room: str, uid: int) -> None:
        members = self.voice.get(room)
        if members is None or uid not in members:
            return
        del members[uid]
        if not members:
            del self.voice[room]
        await self.publish_room(room)

    async def voice_update(self, room: str, uid: int, **flags: bool) -> None:
        m = self.voice.get(room, {}).get(uid)
        if m is None:
            return
        changed = False
        for k, v in flags.items():
            if getattr(m, k) != v:
                setattr(m, k, v)
                changed = True
        if changed:
            await self.publish_room(room)

    async def voice_replace(self, room: str, members: list[VoiceMember]) -> None:
        old = self.voice.get(room, {})
        nxt = {}
        for m in members:
            if (prev := old.get(m.user_id)) is not None:
                m.muted, m.deafened, m.joined_at = prev.muted, prev.deafened, prev.joined_at
            nxt[m.user_id] = m
        changed = len(old) != len(nxt) or any(old.get(uid) != m for uid, m in nxt.items())
        if nxt:
            self.voice[room] = nxt
        else:
            self.voice.pop(room, None)
        if changed:
            await self.publish_room(room)

    def voice_rooms(self) -> list[str]:
        return list(self.voice)

    def voice_members(self, room: str) -> list[VoiceMember]:
        return sorted(self.voice.get(room, {}).values(), key=lambda m: m.joined_at)

    async def visible_voice(self, can_see: Callable[[str], Awaitable[bool]]) -> list[dict]:
        out = []
        for r in list(self.voice):
            if await can_see(r) and r in self.voice:
                out.append(self._snapshot(r))
        return out
