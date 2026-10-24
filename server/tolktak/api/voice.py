import asyncio
import logging
from typing import Annotated

import orjson
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from ..errors import ApiError
from ..livekit import WebhookError
from ..realtime import VoiceMember, event
from ..server import Server, background, current_user, dm_room_name, group_room_name, parse_room_name
from ..store import chat, groups, now
from .common import Body, json_response, no_content, path_id, read_json, server

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("tolktak")

User = Annotated[dict, Depends(current_user)]

# Only for connecting: LiveKit refreshes the token of a connected participant.
TOKEN_TTL = 10 * 60


class JoinReq(Body):
    room_id: int = 0  # group voice room
    channel_id: int = 0  # DM call


async def resolve_room(req: JoinReq, me: int) -> str:
    if req.room_id > 0:
        room = await groups.room_by_id(req.room_id)
        if not await groups.is_group_member(room["group_id"], me):
            raise ApiError(404, "not_found", "Room not found")
        return group_room_name(room["group_id"], room["id"])
    if req.channel_id > 0:
        await chat.dm_peer(req.channel_id, me)
        if not await chat.is_channel_member(req.channel_id, me):
            raise ApiError(404, "not_found", "Chat not found")
        return dm_room_name(req.channel_id)
    raise ApiError(400, "bad_request", "room_id or channel_id is required")


@router.post("/voice/join")
async def voice_join(request: Request, user: User):
    req = await read_json(request, JoinReq)
    room = await resolve_room(req, user["id"])
    s = server(request)
    meta = orjson.dumps({"username": user["username"], "color": user["color"]}).decode()
    token = s.lk.join_token(str(user["id"]), user["display_name"], meta, room, TOKEN_TTL)
    return json_response({"url": s.cfg.livekit_public_url, "token": token, "room": room})


class LeaveReq(Body):
    room: str = ""


@router.post("/voice/leave")
async def voice_leave(request: Request, user: User):
    """Advisory: the SFU webhook is authoritative."""
    req = await read_json(request, LeaveReq)
    await server(request).hub.voice_leave(req.room, user["id"])
    return no_content()


async def call_peer(request: Request, me: int) -> tuple[int, int]:
    cid = path_id(request, "channel")
    if not await chat.is_channel_member(cid, me):
        raise ApiError(404, "not_found", "Chat not found")
    return cid, await chat.dm_peer(cid, me)


@router.post("/calls/{channel}/ring")
async def call_ring(request: Request, user: User):
    cid, peer = await call_peer(request, user["id"])
    s = server(request)
    s.limit(f"ring:{user['id']}", 10, 6, "Too many calls, try again in a minute")
    data = {"channel_id": cid, "from": user["id"], "room": dm_room_name(cid)}
    s.hub.send_to([peer], event("call.ring", data))
    return no_content()


@router.post("/calls/{channel}/decline")
async def call_decline(request: Request, user: User):
    cid, peer = await call_peer(request, user["id"])
    me = user["id"]
    server(request).hub.send_to([peer, me], event("call.declined", {"channel_id": cid, "by": me}))
    return no_content()


@router.post("/calls/{channel}/cancel")
async def call_cancel(request: Request, user: User):
    cid, peer = await call_peer(request, user["id"])
    me = user["id"]
    server(request).hub.send_to([peer, me], event("call.cancelled", {"channel_id": cid, "by": me}))
    return no_content()


async def remove_from_sfu(s: Server, room: str, uid: int) -> None:
    try:
        await s.lk.remove_participant(room, str(uid))
    except Exception as e:
        log.warning("remove participant room=%s user=%d err=%s", room, uid, e)
    await s.hub.voice_leave(room, uid)


def track_flags(source: str, on: bool) -> dict:
    match source:
        case "CAMERA":
            return {"camera": on}
        case "SCREEN_SHARE":
            return {"screen": on}
    return {}


def _identity(p) -> int:
    ident = (p or {}).get("identity", "") if isinstance(p, dict) else ""
    try:
        return int(ident)
    except ValueError:
        return 0


@router.post("/livekit/webhook")
async def livekit_webhook(request: Request):
    s = server(request)
    body = await request.body()
    try:
        ev = s.lk.receive_webhook(request.headers.get("authorization", ""), body[: 1 << 20])
    except WebhookError as e:
        log.warning("rejected livekit webhook: %s", e)
        raise ApiError(401, "unauthorized", "Invalid webhook signature") from None
    room_info = ev.get("room") if isinstance(ev, dict) else None
    room = room_info.get("name", "") if isinstance(room_info, dict) else ""
    if not room or parse_room_name(room) is None:
        return Response(status_code=200)
    uid = _identity(ev.get("participant"))
    match ev.get("event"):
        case "participant_joined" if uid > 0:
            if uid in await s.room_members(room):
                await s.hub.voice_join(room, uid)
            else:
                log.info("removing non-member user=%d from room=%s", uid, room)
                background(remove_from_sfu(s, room, uid))
        case "participant_left" | "participant_connection_aborted" if uid > 0:
            await s.hub.voice_leave(room, uid)
            await maybe_end_call(s, room)
        case "track_published" | "track_unpublished" if uid > 0 and isinstance(ev.get("track"), dict):
            flags = track_flags(ev["track"].get("source", ""), ev["event"] == "track_published")
            if flags:
                await s.hub.voice_update(room, uid, **flags)
        case "room_finished":
            await s.hub.voice_replace(room, [])
            await maybe_end_call(s, room)
    return Response(status_code=200)


async def maybe_end_call(s: Server, room: str) -> None:
    parsed = parse_room_name(room)
    if parsed is None or parsed[0] != "dm" or s.hub.voice_members(room):
        return
    s.hub.send_to(await s.room_audience(room), event("call.ended", {"channel_id": parsed[1]}))


async def reconcile_once(s: Server) -> None:
    """Missed webhooks, as during a restart, would leave ghosts in the sidebar."""
    try:
        rooms = await s.lk.list_rooms()
    except Exception as e:
        log.debug("reconcile: list rooms: %s", e)
        return
    active = set()
    for room in rooms:
        name = room.get("name", "")
        if parse_room_name(name) is None:
            continue
        active.add(name)
        try:
            parts = await s.lk.list_participants(name)
        except Exception as e:
            log.debug("reconcile: list participants room=%s: %s", name, e)
            continue
        allowed = set(await s.room_members(name))
        members = []
        for p in parts:
            uid = _identity(p)
            if uid <= 0:
                continue
            if uid not in allowed:
                log.info("removing non-member user=%d from room=%s", uid, name)
                background(remove_from_sfu(s, name, uid))
                continue
            m = VoiceMember(user_id=uid, joined_at=now())
            for t in p.get("tracks") or []:
                for k, v in track_flags(t.get("source", ""), True).items():
                    setattr(m, k, v)
            members.append(m)
        await s.hub.voice_replace(name, members)
    for r in s.hub.voice_rooms():
        if r not in active:
            await s.hub.voice_replace(r, [])


async def reconcile_loop(s: Server, every: float) -> None:
    while True:
        try:
            await asyncio.wait_for(reconcile_once(s), 10)
        except TimeoutError:
            log.debug("reconcile: timed out")
        except Exception:
            log.exception("reconcile")
        await asyncio.sleep(every)
