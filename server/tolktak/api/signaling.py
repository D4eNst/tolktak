import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode

import httpx
import orjson
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, Response
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from ..errors import ApiError, NotFound
from ..livekit import WebhookError
from ..store import users
from .common import server

router = APIRouter()
transport_log = logging.getLogger("tolktak.rtc.transport")
transport_log.setLevel(logging.WARNING)


class SignalPrivacy:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("path", "").startswith("/rtc"):
            query = scope.get("query_string", b"")
            scope.setdefault("state", {})["voice_query"] = query
            # Mutate the original ASGI scope too: server access logs use that object.
            scope["query_string"] = urlencode(
                [
                    (key, value)
                    for key, value in parse_qsl(query.decode(errors="replace"), keep_blank_values=True)
                    if key.lower() not in {"access_token", "token", "join_request"}
                ]
            ).encode()
        await self.app(scope, receive, send)


def _query(scope, headers) -> tuple[str, list[tuple[str, str]]]:
    raw = scope.get("state", {}).get("voice_query", scope.get("query_string", b""))
    pairs = parse_qsl(raw.decode(errors="replace"), keep_blank_values=True)
    tokens = [value for key, value in pairs if key == "access_token"]
    bearer = headers.get("authorization", "").removeprefix("Bearer ")
    if len(tokens) > 1 or tokens and bearer and tokens[0] != bearer:
        raise ApiError(401, "unauthorized", "Invalid voice token")
    token = tokens[0] if tokens else bearer
    if not token or any(key == "publish" and value for key, value in pairs):
        raise ApiError(401, "unauthorized", "Voice token is required")
    return token, [(key, value) for key, value in pairs if key not in {"access_token", "token"}]


async def _authorize(s, token: str) -> tuple[str, int]:
    try:
        claims = s.lk.verify(token)
        exp = claims.get("exp")
        uid = int(claims.get("sub", ""))
        video = claims.get("video")
        if type(exp) is not int or exp <= time.time() or not 0 < uid < 1 << 63:
            raise ValueError
        if not isinstance(video, dict) or video.get("roomJoin") is not True or not isinstance(video.get("room"), str):
            raise ValueError
        room = video["room"]
        await s.moderation.current(room, uid)
        return room, uid
    except WebhookError, ValueError, TypeError, NotFound:
        raise ApiError(401, "unauthorized", "Invalid or inaccessible voice token") from None


async def _fresh(s, room: str, uid: int, token: str) -> str:
    permissions = await s.moderation.current(room, uid)
    if not permissions["allowed"]["entry"]:
        raise ApiError(403, "voice_forbidden", "You cannot enter this call")
    user = await users.user_by_id(uid)
    meta = orjson.dumps({"username": user["username"], "color": user["color"]}).decode()
    exp = s.lk.verify(token)["exp"]
    if exp <= time.time():
        raise ApiError(401, "unauthorized", "Voice token expired")
    remaining = max(1, int(exp - time.time()))
    return s.lk.join_token(str(uid), user["display_name"], meta, room, remaining, permissions["allowed"])


@dataclass(eq=False)
class SignalBridge:
    upstream: ClientConnection

    async def close(self) -> None:
        await self.upstream.close(code=1008, reason="Removed from call")


@router.get("/rtc/validate")
@router.get("/rtc/v1/validate")
async def validate(request: Request):
    s = server(request)
    token, pairs = _query(request.scope, request.headers)
    room, uid = await _authorize(s, token)
    async with s.moderation.lock(room):
        fresh = await _fresh(s, room, uid, token)
        try:
            response = await s.lk.http.get(
                s.lk.internal_url + request.url.path,
                params=urlencode(pairs),
                headers={"Authorization": "Bearer " + fresh},
            )
        except httpx.HTTPError, OSError, RuntimeError:
            return PlainTextResponse("Voice service unavailable", status_code=503)
        return Response(
            response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "text/plain"),
        )


@router.websocket("/rtc")
@router.websocket("/rtc/v1")
async def signaling(ws: WebSocket):
    s = ws.app.state.server
    upstream = bridge = None
    room = ""
    cancelled = False
    try:
        token, pairs = _query(ws.scope, ws.headers)
        room, uid = await _authorize(s, token)
        async with s.moderation.lock(room):
            parts = await s.moderation.refresh(room)
            await s.moderation.apply(room, uid, parts)
            fresh = await _fresh(s, room, uid, token)
            base = s.lk.internal_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
            uri = base + ws.url.path + ("?" + urlencode(pairs) if pairs else "")
            upstream = await connect(
                uri,
                additional_headers={"Authorization": "Bearer " + fresh},
                proxy=None,
                max_size=2 << 20,
                open_timeout=5,
                close_timeout=1,
                logger=transport_log,
            )
            first = await asyncio.wait_for(upstream.recv(), 5)
            # Membership can be revoked while the SFU handshake awaits network I/O.
            await s.moderation.current(room, uid)
            bridge = SignalBridge(upstream)
            s.moderation.bridges.setdefault(room, {})[bridge] = uid
            await s.moderation.observe(room, True)
            await ws.accept()
        if isinstance(first, bytes):
            await ws.send_bytes(first)
        else:
            await ws.send_text(first)

        connection = upstream

        async def inbound():
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    return
                data = message.get("bytes")
                if data is None:
                    data = message.get("text") or ""
                await connection.send(data)

        async def outbound():
            async for message in connection:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_text(message)

        tasks = [asyncio.create_task(inbound()), asyncio.create_task(outbound())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except asyncio.CancelledError:
        cancelled = True
    except (
        ApiError,
        NotFound,
        OSError,
        RuntimeError,
        TimeoutError,
        WebSocketException,
        WebSocketDisconnect,
        httpx.HTTPError,
    ):
        with contextlib.suppress(Exception):
            await ws.close(code=1008, reason="Voice connection unavailable or forbidden")
    finally:
        if upstream is not None:
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await upstream.close()
        if bridge is not None:
            entries = s.moderation.bridges.get(room, {})
            entries.pop(bridge, None)
            if not entries:
                s.moderation.bridges.pop(room, None)
            if not cancelled:
                with contextlib.suppress(NotFound, OSError, RuntimeError, httpx.HTTPError, asyncio.CancelledError):
                    async with s.moderation.lock(room):
                        await s.moderation.refresh(room)
