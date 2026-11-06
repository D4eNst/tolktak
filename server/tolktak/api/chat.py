import re
import unicodedata
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from ..errors import ApiError, Conflict, FileMissing, Forbidden, NotFound
from ..realtime import event
from ..server import current_user
from ..store import chat, groups
from ..store.files import valid_file_id
from .common import Body, json_response, path_id, query_int, read_json, server
from .files import remove_unused_files

router = APIRouter(prefix="/api/v1")

User = Annotated[dict, Depends(current_user)]

MAX_MESSAGE_LEN = 4000


async def require_channel(cid: int, uid: int) -> None:
    if not await chat.is_channel_member(cid, uid):
        raise ApiError(404, "not_found", "Chat not found")


@router.get("/channels")
async def list_channels(user: User):
    return json_response({"channels": await chat.list_channels(user["id"])})


class OpenDMReq(Body):
    user_id: int = 0


@router.post("/dms")
async def open_dm(request: Request, user: User):
    req = await read_json(request, OpenDMReq)
    me = user["id"]
    cid, created = await chat.ensure_dm(me, req.user_id)
    if created:
        server(request).hub.send_to([req.user_id], event("channel.created", chat.channel_summary(cid, "dm", me)))
    return json_response({"channel": chat.channel_summary(cid, "dm", req.user_id)})


@router.get("/channels/{id}/messages")
async def list_messages(request: Request, user: User):
    cid = path_id(request)
    await require_channel(cid, user["id"])
    limit = query_int(request, "limit")
    if not 0 < limit <= 100:
        limit = 50
    if search := request.query_params.get("q", "").strip():
        server(request).limit(f"search:{user['id']}", 10, 30, "Too many searches, slow down")
        msgs = await chat.search_messages(cid, search, limit)
    else:
        msgs = await chat.list_messages(cid, query_int(request, "before"), query_int(request, "after"), limit)
    return json_response({"messages": msgs})


@router.get("/channels/{id}/history")
async def history(request: Request, user: User):
    cid = path_id(request)
    allowed = {"before", "after", "around", "limit"}
    params = request.query_params
    values = {}
    for name, raw in params.multi_items():
        if name not in allowed or name in values or not re.fullmatch(r"[0-9]{1,19}", raw):
            raise ApiError(400, "bad_request", "Invalid history query")
        value = int(raw)
        if not 0 <= value < 1 << 63 or (value == 0 and name != "after") or (name == "limit" and value > 100):
            raise ApiError(400, "bad_request", "Invalid history query")
        values[name] = value
    if sum(name in values for name in ("before", "after", "around")) > 1:
        raise ApiError(400, "bad_request", "Use one history cursor")
    return json_response(await chat.history_page(cid, user["id"], **values))


@router.get("/channels/{id}/changes")
async def changes(request: Request, user: User):
    values = {}
    for name, raw in request.query_params.multi_items():
        if name not in {"since", "limit"} or name in values or not re.fullmatch(r"[0-9]{1,19}", raw):
            raise ApiError(400, "bad_request", "Invalid changes query")
        value = int(raw)
        if not 0 <= value < 1 << 63 or (name == "limit" and not 1 <= value <= 100):
            raise ApiError(400, "bad_request", "Invalid changes query")
        values[name] = value
    if "since" not in values:
        raise ApiError(400, "bad_request", "Changes cursor is required")
    result = await chat.message_changes(path_id(request), user["id"], **values)
    return json_response(result)


@router.get("/channels/{id}/search")
async def search_messages(request: Request, user: User):
    query = None
    values = {}
    for name, raw in request.query_params.multi_items():
        if name == "q" and query is None:
            if not 2 <= len(raw) <= 256 or "\x00" in raw:
                raise ApiError(400, "bad_request", "Search must be 2-256 characters")
            query = raw
        elif name in {"before", "limit"} and name not in values and re.fullmatch(r"[0-9]{1,19}", raw):
            value = int(raw)
            if not 0 < value < 1 << 63 or (name == "limit" and value > 100):
                raise ApiError(400, "bad_request", "Invalid search query")
            values[name] = value
        else:
            raise ApiError(400, "bad_request", "Invalid search query")
    if query is None:
        raise ApiError(400, "bad_request", "Search query is required")
    server(request).limit(f"search:{user['id']}", 10, 30, "Too many searches, slow down")
    return json_response(await chat.search_page(path_id(request), user["id"], query, **values))


class SendReq(Body):
    text: str = ""
    nonce: str = ""
    reply_to: int = 0
    attachments: list[str] = []


@router.post("/channels/{id}/messages")
async def send_message(request: Request, user: User):
    cid = path_id(request)
    await require_channel(cid, user["id"])
    req = await read_json(request, SendReq)
    text = req.text.strip()
    if (not text and not req.attachments) or len(text) > MAX_MESSAGE_LEN:
        raise ApiError(400, "bad_text", "Message must be 1-4000 characters")
    if len(req.attachments) > 10:
        raise ApiError(400, "too_many_files", "At most 10 attachments per message")
    if not all(valid_file_id(f) for f in req.attachments):
        raise ApiError(400, "bad_file", "Invalid file ID")
    if not req.nonce or len(req.nonce.encode()) > 64:
        raise ApiError(400, "bad_nonce", "Nonce is required (up to 64 characters)")
    s = server(request)
    me = user["id"]
    s.limit(f"msg:{me}", 30, 120, "Too many messages, slow down")
    try:
        m, created = await chat.create_message(cid, me, req.nonce, text, req.reply_to, req.attachments)
    except FileMissing:
        raise ApiError(404, "file_missing", "An uploaded file is no longer available") from None
    except Forbidden:
        raise ApiError(403, "bad_file", "Attachments must be files you uploaded") from None
    if created:
        s.hub.send_to(await chat.channel_members(cid), event("message.created", m))
    return json_response({"message": m})


class ReadReq(Body):
    message_id: Annotated[int, Field(strict=True, gt=0, lt=1 << 63)]


@router.get("/channels/{id}/read")
async def get_read_state(request: Request, user: User):
    return json_response(await chat.read_state(path_id(request), user["id"]))


@router.post("/channels/{id}/read")
async def mark_read(request: Request, user: User):
    cid = path_id(request)
    await require_channel(cid, user["id"])
    req = await read_json(request, ReadReq)
    me = user["id"]
    state = await chat.mark_read(cid, me, req.message_id)
    server(request).hub.send_to([me], event("channel.read", state))
    return json_response(state)


async def can_moderate_channel(cid: int, uid: int) -> bool:
    gid = await chat.group_of_channel(cid)
    if gid == 0:
        return await chat.is_channel_member(cid, uid)
    try:
        return groups.can_moderate(await groups.group_by_id(gid), uid)
    except NotFound:
        return False


async def message_for(request: Request, uid: int) -> dict:
    m = await chat.message_by_id(path_id(request))
    await require_channel(m["channel_id"], uid)
    return m


async def publish_message(request: Request, m: dict) -> None:
    server(request).hub.send_to(await chat.channel_members(m["channel_id"]), event("message.updated", m))


class EditReq(Body):
    text: str = ""


@router.patch("/messages/{id}")
async def edit_message(request: Request, user: User):
    m = await message_for(request, user["id"])
    req = await read_json(request, EditReq)
    text = req.text.strip()
    if (not text and not m["attachments"]) or len(text) > MAX_MESSAGE_LEN:
        raise ApiError(400, "bad_text", "Message must be 1-4000 characters")
    if m["author_id"] != user["id"]:
        raise ApiError(403, "not_own_message", "You can only edit your own messages")
    m = await chat.edit_message(m["id"], user["id"], text)
    await publish_message(request, m)
    return json_response({"message": m})


@router.delete("/messages/{id}")
async def delete_message(request: Request, user: User):
    m = await message_for(request, user["id"])
    if m["author_id"] != user["id"]:
        gid = await chat.group_of_channel(m["channel_id"])
        if gid == 0 or not await can_moderate_channel(m["channel_id"], user["id"]):
            raise ApiError(403, "not_own_message", "You can only delete your own messages")
    deleted = await chat.delete_message(m["id"], user["id"])
    await publish_message(request, deleted)
    await remove_unused_files(server(request), [f["id"] for f in m["attachments"]])
    return json_response({"message": deleted})


class ReactReq(Body):
    emoji: str = ""


# A reaction carries no text: no letters, digits, spaces or controls, except in a keycap such as 1️⃣.
def is_emoji(s: str) -> bool:
    if re.fullmatch("[0-9#*]\ufe0f?\u20e3", s):
        return True
    cats = [unicodedata.category(c) for c in s]
    if any(c[0] in "LNZ" or c in ("Cc", "Co", "Cs") for c in cats):
        return False
    return any(c[0] in "SP" for c in cats)


@router.post("/messages/{id}/reactions")
async def react(request: Request, user: User):
    m = await message_for(request, user["id"])
    req = await read_json(request, ReactReq)
    e = req.emoji.strip()
    if not e or len(e.encode()) > 64 or not is_emoji(e) or m["deleted"]:
        raise ApiError(400, "bad_emoji", "Invalid reaction")
    server(request).limit(f"react:{user['id']}", 30, 120, "Too many reactions, slow down")
    try:
        m = await chat.toggle_reaction(m["id"], user["id"], e)
    except Conflict:
        raise ApiError(400, "too_many_reactions", "Too many different reactions on this message") from None
    await publish_message(request, m)
    return json_response({"message": m})


@router.api_route("/messages/{id}/pin", methods=["POST", "DELETE"])
async def pin(request: Request, user: User):
    m = await message_for(request, user["id"])
    if not await can_moderate_channel(m["channel_id"], user["id"]):
        raise ApiError(403, "pin_forbidden", "Only group moderators can pin messages")
    m = await chat.set_pinned(m["id"], user["id"], request.method == "POST")
    await publish_message(request, m)
    return json_response({"message": m})


@router.get("/channels/{id}/pins")
async def list_pins(request: Request, user: User):
    cid = path_id(request)
    return json_response(await chat.pinned_page(cid, user["id"]))
