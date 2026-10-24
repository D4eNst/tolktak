import logging
from enum import IntEnum
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ..errors import ApiError
from ..realtime import event
from ..server import Server, background, current_user, group_room_name
from ..store import chat, groups, valid_name
from .auth import image_file, trimmed_max
from .common import Body, json_response, no_content, path_id, read_json, server
from .files import remove_unused_files
from .voice import remove_from_sfu

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("tolktak")

User = Annotated[dict, Depends(current_user)]

MAX_GROUP_MEMBERS = 200


class Need(IntEnum):
    MEMBER = 0
    MOD = 1
    OWNER = 2


async def load_group(gid: int, me: int, need: Need) -> dict:
    g = await groups.group_by_id(gid)
    if me not in g["members"]:
        raise ApiError(404, "group_not_found", "Group not found")
    if need == Need.OWNER and g["owner_id"] != me:
        raise ApiError(403, "owner_only", "Only the group owner can do this")
    if need == Need.MOD and not groups.can_moderate(g, me):
        raise ApiError(403, "moderators_only", "Only the group owner or moderators can do this")
    return g


async def publish_group(s: Server, gid: int) -> None:
    g = await groups.group_by_id(gid)
    s.hub.send_to(g["members"], event("group.updated", g))


async def remove_group(s: Server, g: dict) -> None:
    fids = await chat.attachments_in([c["id"] for c in g["text_channels"]])
    await groups.delete_group(g["id"])
    await remove_unused_files(s, fids)


def kick_rooms(s: Server, g: dict, uid: int | None) -> None:
    for room in g["rooms"]:
        name = group_room_name(g["id"], room["id"])
        for m in s.hub.voice_members(name):
            if uid is None or m.user_id == uid:
                background(remove_from_sfu(s, name, m.user_id))


@router.get("/groups")
async def list_groups(user: User):
    return json_response({"groups": await groups.groups_for_user(user["id"])})


class CreateGroupReq(Body):
    name: str = ""
    members: list[int] = []
    room_name: str = ""
    channel_name: str = ""


@router.post("/groups")
async def create_group(request: Request, user: User):
    req = await read_json(request, CreateGroupReq)
    name, ok = valid_name(req.name, 60)
    if not ok:
        raise ApiError(400, "bad_name", "Group name must be 1-60 characters")
    if len(req.members) > MAX_GROUP_MEMBERS:
        raise ApiError(400, "too_many_members", "A group can have at most 200 members")
    room_name, ok = valid_name(req.room_name, 40)
    if not ok:
        room_name = "General"
    channel_name, ok = valid_name(req.channel_name, 40)
    if not ok:
        channel_name = "general"
    s = server(request)
    s.limit(f"group:{user['id']}", 10, 5, "Too many new groups, try again in a minute")
    g = await groups.create_group(name, user["id"], req.members, room_name, channel_name)
    s.hub.send_to(g["members"], event("group.updated", g))
    return json_response({"group": g}, 201)


class UpdateGroupReq(Body):
    name: str | None = None
    avatar: str | None = None
    description: str | None = None


@router.patch("/groups/{id}")
async def update_group(request: Request, user: User):
    gid = path_id(request)
    req = await read_json(request, UpdateGroupReq)
    patch = {}
    if req.name is not None:
        name, ok = valid_name(req.name, 60)
        if not ok:
            raise ApiError(400, "bad_name", "Group name must be 1-60 characters")
        patch["name"] = name
    if req.description is not None:
        d, ok = trimmed_max(req.description, 300)
        if not ok:
            raise ApiError(400, "bad_description", "Description must be at most 300 characters")
        patch["description"] = d
    if req.avatar is not None:
        if req.avatar and not await image_file(req.avatar, user["id"]):
            raise ApiError(400, "bad_avatar", "Group picture must be an image you uploaded")
        patch["avatar"] = req.avatar
    await load_group(gid, user["id"], Need.MOD)
    await groups.update_group(gid, **patch)
    await publish_group(server(request), gid)
    return no_content()


@router.delete("/groups/{id}")
async def delete_group(request: Request, user: User):
    gid = path_id(request)
    g = await load_group(gid, user["id"], Need.OWNER)
    s = server(request)
    await remove_group(s, g)
    kick_rooms(s, g, None)
    s.hub.send_to(g["members"], event("group.deleted", {"id": gid}))
    return no_content()


class AddMembersReq(Body):
    user_ids: list[int] = []


@router.post("/groups/{id}/members")
async def add_members(request: Request, user: User):
    gid = path_id(request)
    req = await read_json(request, AddMembersReq)
    g = await load_group(gid, user["id"], Need.MOD)
    if len(g["members"]) + len(req.user_ids) > MAX_GROUP_MEMBERS:
        raise ApiError(400, "too_many_members", "A group can have at most 200 members")
    await groups.add_group_members(gid, req.user_ids)
    await publish_group(server(request), gid)
    return no_content()


@router.delete("/groups/{id}/members/{uid}")
async def remove_member(request: Request, user: User):
    gid = path_id(request)
    uid = path_id(request, "uid")
    me = user["id"]
    g = await load_group(gid, me, Need.MEMBER if uid == me else Need.MOD)
    if uid != me:
        match groups.role(g, uid):
            case "":
                raise ApiError(404, "member_not_found", "User is not a member of this group")
            case "owner":
                raise ApiError(403, "cannot_kick_owner", "The group owner cannot be removed")
            case "mod" if g["owner_id"] != me:
                raise ApiError(403, "cannot_kick_moderator", "Only the group owner can remove a moderator")
    await groups.remove_group_member(gid, uid)
    s = server(request)
    kick_rooms(s, g, uid)
    if len(g["members"]) == 1:
        # Last member left: the group disappears.
        await remove_group(s, g)
        s.hub.send_to([uid], event("group.deleted", {"id": gid}))
        return no_content()
    if uid == g["owner_id"]:
        try:
            await groups.transfer_ownership(gid)
        except Exception:
            log.exception("transfer ownership")
    s.hub.send_to([uid], event("group.deleted", {"id": gid}))
    await publish_group(s, gid)
    return no_content()


class NameReq(Body):
    name: str = ""


@router.post("/groups/{id}/rooms")
async def create_room(request: Request, user: User):
    gid = path_id(request)
    req = await read_json(request, NameReq)
    name, ok = valid_name(req.name, 40)
    if not ok:
        raise ApiError(400, "bad_name", "Room name must be 1-40 characters")
    g = await load_group(gid, user["id"], Need.MOD)
    if len(g["rooms"]) >= 20:
        raise ApiError(400, "too_many_rooms", "A group can have at most 20 rooms")
    room = await groups.create_room(gid, name)
    await publish_group(server(request), gid)
    return json_response({"room": room}, 201)


async def room_for_mod(request: Request, uid: int) -> tuple[dict, dict]:
    room = await groups.room_by_id(path_id(request))
    return room, await load_group(room["group_id"], uid, Need.MOD)


@router.patch("/rooms/{id}")
async def rename_room(request: Request, user: User):
    req = await read_json(request, NameReq)
    name, ok = valid_name(req.name, 40)
    if not ok:
        raise ApiError(400, "bad_name", "Room name must be 1-40 characters")
    room, g = await room_for_mod(request, user["id"])
    await groups.rename_room(room["id"], name)
    await publish_group(server(request), g["id"])
    return no_content()


@router.delete("/rooms/{id}")
async def delete_room(request: Request, user: User):
    room, g = await room_for_mod(request, user["id"])
    if len(g["rooms"]) <= 1:
        raise ApiError(400, "last_room", "A group must keep at least one room")
    await groups.delete_room(room["id"])
    s = server(request)
    name = group_room_name(g["id"], room["id"])
    for m in s.hub.voice_members(name):
        background(remove_from_sfu(s, name, m.user_id))
    await publish_group(s, g["id"])
    return no_content()


class RoleReq(Body):
    role: str = ""


@router.put("/groups/{id}/members/{uid}/role")
async def set_role(request: Request, user: User):
    gid = path_id(request)
    uid = path_id(request, "uid")
    req = await read_json(request, RoleReq)
    if req.role not in ("mod", "member"):
        raise ApiError(400, "bad_role", 'Role must be "mod" or "member"')
    g = await load_group(gid, user["id"], Need.OWNER)
    if uid == g["owner_id"]:
        raise ApiError(400, "owner_role_fixed", "The owner's role cannot be changed")
    await groups.set_group_role(gid, uid, req.role)
    await publish_group(server(request), gid)
    return no_content()


@router.post("/groups/{id}/channels")
async def create_text_channel(request: Request, user: User):
    gid = path_id(request)
    req = await read_json(request, NameReq)
    name, ok = valid_name(req.name, 40)
    if not ok:
        raise ApiError(400, "bad_name", "Chat name must be 1-40 characters")
    g = await load_group(gid, user["id"], Need.MOD)
    if len(g["text_channels"]) >= 30:
        raise ApiError(400, "too_many_channels", "A group can have at most 30 chats")
    cid, position = await groups.create_text_channel(gid, name)
    s = server(request)
    s.hub.send_to(g["members"], event("channel.created", chat.channel_summary(cid, "group", group_id=gid)))
    await publish_group(s, gid)
    return json_response({"channel": {"id": cid, "name": name, "position": position}}, 201)


async def text_channel_for_mod(request: Request, uid: int) -> tuple[int, dict]:
    cid = path_id(request)
    gid = await chat.group_of_channel(cid)
    if gid == 0:
        raise ApiError(404, "not_found", "Chat not found")
    return cid, await load_group(gid, uid, Need.MOD)


@router.patch("/text-channels/{id}")
async def rename_text_channel(request: Request, user: User):
    req = await read_json(request, NameReq)
    name, ok = valid_name(req.name, 40)
    if not ok:
        raise ApiError(400, "bad_name", "Chat name must be 1-40 characters")
    cid, g = await text_channel_for_mod(request, user["id"])
    await groups.rename_text_channel(cid, name)
    await publish_group(server(request), g["id"])
    return no_content()


@router.delete("/text-channels/{id}")
async def delete_text_channel(request: Request, user: User):
    cid, g = await text_channel_for_mod(request, user["id"])
    if cid == g["channel_id"]:
        raise ApiError(400, "main_channel", "The main group chat cannot be deleted")
    fids = await chat.attachments_in([cid])
    await groups.delete_text_channel(cid)
    s = server(request)
    await remove_unused_files(s, fids)
    s.hub.send_to(g["members"], event("channel.deleted", {"id": cid}))
    await publish_group(s, g["id"])
    return no_content()
