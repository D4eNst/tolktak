"""The token comes in the first frame, never in the URL. The 25 s ping detects half-open connections."""

import asyncio
import contextlib
import logging

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..errors import NotFound
from ..realtime import Conn, event
from ..server import Server
from ..store import chat, users

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("tolktak")

PING_EVERY = 25
PING = b'{"type":"ping"}'
MAX_FRAME = 64 << 10


async def _read(ws: WebSocket) -> dict | None:
    msg = await ws.receive()
    if msg["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(msg.get("code", 1000))
    data = msg.get("text")
    if data is None:
        data = msg.get("bytes") or b""
    if len(data) > MAX_FRAME:
        await ws.close(1009, "message too big")
        raise WebSocketDisconnect(1009)
    try:
        frame = orjson.loads(data)
    except orjson.JSONDecodeError:
        return None
    return frame if isinstance(frame, dict) else None


def _int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def _bool(v) -> bool:
    return v is True


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    s: Server = ws.app.state.server
    # Desktop clients send Origin "file://" or the dev server; authentication is by token.
    await ws.accept()
    try:
        first = await asyncio.wait_for(_read(ws), 10)
    except TimeoutError, WebSocketDisconnect:
        first = None
    if not first or first.get("type") != "auth":
        await _close(ws, 4001, "auth required")
        return
    try:
        user = await users.user_by_token(_str(first.get("token")))
    except NotFound:
        await _close(ws, 4001, "invalid token")
        return

    conn = s.hub.register(user["id"])
    writer = None
    try:
        hello = {
            "user": user,
            "online": s.hub.online(),
            "voice": await s.hub.visible_voice(s.can_see_room(user["id"])),
            "server": {"name": s.cfg.server_name, "version": s.version},
        }
        await ws.send_text(event("hello", hello).decode())
        writer = asyncio.create_task(_writer(ws, conn))
        reader = asyncio.create_task(_reader(ws, s, user["id"]))
        done, _ = await asyncio.wait({writer, reader}, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            e = t.exception()
            if e is not None and not isinstance(e, (WebSocketDisconnect, TimeoutError, OSError, RuntimeError)):
                log.warning("websocket error user=%d err=%r", user["id"], e)
        for t in (writer, reader):
            if t not in done:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
    except WebSocketDisconnect:
        pass
    finally:
        s.hub.unregister(conn)
        if writer is not None and not writer.done():
            writer.cancel()


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code, reason)


async def _writer(ws: WebSocket, conn: Conn) -> None:
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + PING_EVERY
    while True:
        try:
            b = await asyncio.wait_for(conn.queue.get(), max(0, next_ping - loop.time()))
        except TimeoutError:
            b = PING
            next_ping = loop.time() + PING_EVERY
        if b is None:
            if conn.kicked:
                await _close(ws, 4008, "too slow")
            return
        await asyncio.wait_for(ws.send_text(b.decode()), 10)


async def _reader(ws: WebSocket, s: Server, uid: int) -> None:
    while True:
        f = await _read(ws)
        if f is None:
            continue
        match f.get("type"):
            case "typing":
                cid = _int(f.get("channel_id"))
                if await chat.is_channel_member(cid, uid):
                    others = [m for m in await chat.channel_members(cid) if m != uid]
                    s.hub.send_to(others, event("typing", {"channel_id": cid, "user_id": uid}))
            case "voice.state":
                # Only flags of a room the user is actually in (per SFU) are accepted.
                await s.hub.voice_update(
                    _str(f.get("room")), uid, muted=_bool(f.get("muted")), deafened=_bool(f.get("deafened"))
                )
            case "voice.joined":
                # Optimistic presence until the SFU webhook arrives.
                room = _str(f.get("room"))
                if await s.can_see_room(uid)(room):
                    await s.hub.voice_join(room, uid)
                    await s.hub.voice_update(room, uid, muted=_bool(f.get("muted")), deafened=_bool(f.get("deafened")))
