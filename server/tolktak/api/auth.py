import logging
import re
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ..errors import ApiError, Conflict, Forbidden, NotFound
from ..realtime import event
from ..server import admin_user, current_user
from ..store import files, users, valid_name
from .common import Body, json_response, no_content, read_json, server

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("tolktak")

User = Annotated[dict, Depends(current_user)]
Admin = Annotated[dict, Depends(admin_user)]

USERNAME = re.compile(r"[a-zA-Z0-9_.-]{3,32}")
DAY_MS = 24 * 60 * 60 * 1000


@router.get("/server")
async def server_info(request: Request):
    s = server(request)
    reg = "first" if await users.count_users() == 0 else s.cfg.registration
    return json_response({
        "name": s.cfg.server_name,
        "version": s.version,
        "registration": reg,
        "livekit_url": s.cfg.livekit_public_url,
        "client_download_url": s.cfg.client_download_url,
    })  # fmt: skip


class RegisterReq(Body):
    username: str = ""
    display_name: str = ""
    password: str = ""
    invite: str = ""


@router.post("/auth/register")
async def register(request: Request):
    s = server(request)
    s.limit("register:" + s.client_ip(request), 5, 2, "Too many attempts, try again in a minute")
    req = await read_json(request, RegisterReq)
    username = req.username.strip()
    if not USERNAME.fullmatch(username):
        raise ApiError(400, "bad_username", "Username must be 3-32 characters: Latin letters, digits, _ . -")
    display, ok = valid_name(req.display_name, 40)
    if not ok:
        display = username
    if not 8 <= len(req.password.encode()) <= 256:
        raise ApiError(400, "bad_password", "Password must be 8-256 characters")
    invite = ""
    if await users.count_users() > 0:
        match s.cfg.registration:
            case "open":
                pass
            case "invite":
                invite = req.invite.strip().upper()
                if not invite:
                    raise ApiError(403, "invite_required", "An invite code is required")
            case _:
                raise ApiError(403, "registration_closed", "Registration is closed on this server")
    try:
        u = await users.create_user(username, display, req.password, invite)
    except Conflict:
        raise ApiError(409, "username_taken", "Username is already taken") from None
    except Forbidden:
        raise ApiError(403, "invite_invalid", "Invite code is invalid, expired or used up") from None
    log.info("user registered id=%d username=%s admin=%s", u["id"], u["username"], u["is_admin"])
    s.hub.broadcast_all(event("user.created", u))
    return json_response({"user": u}, 201)


class LoginReq(Body):
    username: str = ""
    password: str = ""
    device: str = ""


@router.post("/auth/login")
async def login(request: Request):
    s = server(request)
    req = await read_json(request, LoginReq)
    username = req.username.strip()
    ip = s.client_ip(request)
    s.limit("login-ip:" + ip, 10, 5, "Too many login attempts, try again in a minute")
    s.limit("login-user:" + username.lower()[:64], 10, 5, "Too many login attempts, try again in a minute")
    try:
        u = await users.authenticate(username, req.password)
    except NotFound:
        # The name shows whether the account exists, the password is never logged.
        log.info("login failed username=%r ip=%s", username[:64], ip)
        raise ApiError(401, "bad_credentials", "Invalid username or password") from None
    device = req.device.encode()[:64].decode(errors="ignore")
    token = await users.create_session(u["id"], device)
    return json_response({"token": token, "user": u})


@router.post("/auth/logout")
async def logout(request: Request, user: User):
    token = request.state.token
    await users.delete_session(token)
    server(request).hub.end_sessions(user["id"], [users.token_hash(token)])
    return no_content()


@router.get("/me")
async def me(user: User):
    return json_response({"user": user})


class ProfileReq(Body):
    display_name: str | None = None
    about: str | None = None
    status: str | None = None
    avatar: str | None = None


async def image_file(fid: str, uid: int) -> bool:
    if not files.valid_file_id(fid):
        return False
    try:
        meta, uploader = await files.file_by_id(fid)
    except NotFound:
        return False
    return uploader == uid and meta["mime"].startswith("image/")


def trimmed_max(v: str, max_len: int) -> tuple[str, bool]:
    v = v.strip()
    return v, len(v) <= max_len


@router.patch("/me")
async def update_me(request: Request, user: User):
    req = await read_json(request, ProfileReq)
    patch = {}
    if req.display_name is not None:
        name, ok = valid_name(req.display_name, 40)
        if not ok:
            raise ApiError(400, "bad_name", "Display name must be 1-40 characters")
        patch["display_name"] = name
    if req.about is not None:
        v, ok = trimmed_max(req.about, 300)
        if not ok:
            raise ApiError(400, "bad_about", "About must be at most 300 characters")
        patch["about"] = v
    if req.status is not None:
        v, ok = trimmed_max(req.status, 80)
        if not ok:
            raise ApiError(400, "bad_status", "Status must be at most 80 characters")
        patch["status"] = v
    if req.avatar is not None:
        if req.avatar and not await image_file(req.avatar, user["id"]):
            raise ApiError(400, "bad_avatar", "Avatar must be an image you uploaded")
        patch["avatar"] = req.avatar
    s = server(request)
    s.limit(f"profile:{user['id']}", 10, 10, "Too many profile changes, slow down")
    u = await users.update_profile(user["id"], **patch)
    s.hub.broadcast_all(event("user.updated", u))
    return json_response({"user": u})


class PasswordReq(Body):
    old_password: str = ""
    new_password: str = ""


@router.post("/me/password")
async def change_password(request: Request, user: User):
    req = await read_json(request, PasswordReq)
    if not 8 <= len(req.new_password.encode()) <= 256:
        raise ApiError(400, "bad_password", "Password must be 8-256 characters")
    s = server(request)
    s.limit("pw:" + user["username"], 5, 2, "Too many attempts, try again in a minute")
    try:
        ended = await users.change_password(user["id"], req.old_password, req.new_password, request.state.token)
    except Forbidden:
        raise ApiError(403, "bad_credentials", "Current password is incorrect") from None
    s.hub.end_sessions(user["id"], ended)
    return no_content()


@router.get("/users")
async def list_users(request: Request, _: User):
    hub = server(request).hub
    return json_response({"users": [u | {"online": hub.is_online(u["id"])} for u in await users.list_users()]})


@router.get("/admin/invites")
async def list_invites(_: Admin):
    return json_response({"invites": await users.list_invites()})


class InviteReq(Body):
    max_uses: int = 0
    days: int = 0


@router.post("/admin/invites")
async def create_invite(request: Request, user: Admin):
    req = await read_json(request, InviteReq)
    max_uses = req.max_uses if 1 <= req.max_uses <= 1000 else 1
    days = req.days if 1 <= req.days <= 365 else 7
    inv = await users.create_invite(user["id"], max_uses, days * DAY_MS)
    return json_response({"invite": inv}, 201)


@router.delete("/admin/invites/{code}")
async def delete_invite(code: str, _: Admin):
    await users.delete_invite(code)
    return no_content()
