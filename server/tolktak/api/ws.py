"""Authenticate in the first frame; 25 s pings detect ended sessions and half-open connections."""

import asyncio
import contextlib
import logging

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..errors import NotFound
from ..realtime import Conn, event
from ..server import Server
from ..store import chat, users
from ..updates import MIN_CLIENT_VERSION

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
    # Desktop origins vary; authentication uses the first-frame token.
    await ws.accept()
    try:
        first = await asyncio.wait_for(_read(ws), 10)
    except TimeoutError, WebSocketDisconnect:
        first = None
    if not first or first.get("type") != "auth":
        await _close(ws, 4001, "auth required")
        return
    token = _str(first.get("token"))
    try:
        user = await users.user_by_token(token)
    except NotFound:
        await _close(ws, 4001, "invalid token")
        return

    scope = first.get("profile_scope", "all")
    if scope not in ("all", "watched"):
        await _close(ws, 4002, "unsupported profile scope")
        return
    conn = s.hub.register(user["id"], users.token_hash(token), scope)
    writer = None
    try:
        hello = {
            "user": user,
            "online": [user["id"]] if scope == "watched" else s.hub.online(),
            "profile_scope": scope,
            "voice": await s.hub.visible_voice(s.can_see_room(user["id"])),
            "server": {"name": s.cfg.server_name, "version": s.version, "min_client": MIN_CLIENT_VERSION},
        }
        await ws.send_text(event("hello", hello).decode())
        writer = asyncio.create_task(_writer(ws, conn, token))
        reader = asyncio.create_task(_reader(ws, s, conn))
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


async def _writer(ws: WebSocket, conn: Conn, token: str) -> None:
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + PING_EVERY
    while True:
        try:
            b = await asyncio.wait_for(conn.queue.get(), max(0, next_ping - loop.time()))
        except TimeoutError:
            try:
                await users.user_by_token(token)
            except NotFound:
                await _close(ws, 4001, "session ended")
                return
            b = PING
            next_ping = loop.time() + PING_EVERY
        if b is None:
            if conn.kicked:
                await _close(ws, 4008, "too slow")
            elif conn.revoked:
                await _close(ws, 4001, "session ended")
            return
        await asyncio.wait_for(ws.send_text(b.decode()), 10)


async def _reader(ws: WebSocket, s: Server, conn: Conn) -> None:
    uid = conn.user_id
    while True:
        f = await _read(ws)
        if f is None or not s.rl.allow(f"ws:{uid}", 20, 300):
            continue
        match f.get("type"):
            case "users.watch":
                ids = f.get("user_ids")
                request_id = f.get("request_id")
                valid = (
                    conn.profile_scope == "watched"
                    and isinstance(ids, list)
                    and len(ids) <= 500
                    and all(isinstance(i, int) and not isinstance(i, bool) and 0 < i < 1 << 63 for i in ids)
                    and (request_id is None or isinstance(request_id, str) and len(request_id) <= 64)
                )
                if not valid:
                    s.hub.send_conn(
                        conn, event("error", {"code": "bad_watch", "message": "Invalid profile watch list"})
                    )
                    continue
                assert isinstance(ids, list)
                conn.watched = set(ids)
                profiles = await users.profiles_by_ids(sorted(conn.watched))
                data = {
                    "users": [u | {"online": s.hub.is_online(u["id"])} for u in profiles],
                    "user_ids": sorted(conn.watched),
                }
                if request_id is not None:
                    data["request_id"] = request_id
                s.hub.send_conn(conn, event("users.snapshot", data))
            case "typing":
                cid = _int(f.get("channel_id"))
                if await chat.is_channel_member(cid, uid):
                    others = [m for m in await chat.channel_members(cid) if m != uid]
                    s.hub.send_to(others, event("typing", {"channel_id": cid, "user_id": uid}))
            case "voice.state":
                # The hub accepts flags only for current SFU participants.
                await s.hub.voice_update(
                    _str(f.get("room")), uid, muted=_bool(f.get("muted")), deafened=_bool(f.get("deafened"))
                )
            case "voice.joined":
                # Optimistic presence until the SFU webhook arrives.
                room = _str(f.get("room"))
                if uid in await s.room_audience(room):
                    await s.hub.voice_join(room, uid)
                    await s.hub.voice_update(room, uid, muted=_bool(f.get("muted")), deafened=_bool(f.get("deafened")))
