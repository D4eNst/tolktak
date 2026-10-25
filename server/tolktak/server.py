import asyncio
import logging
import re

from fastapi import Request

from . import storage
from .config import Config
from .errors import ApiError, NotFound
from .livekit import LiveKit
from .ratelimit import RateLimiter
from .realtime import Hub
from .store import chat, groups, users
from .updates import Updater

log = logging.getLogger("tolktak")

# Voice rooms map to LiveKit rooms named "g<group>r<room>" or "dm<channel>".
_GROUP_ROOM = re.compile(r"g([0-9]+)r([0-9]+)")
_DM_ROOM = re.compile(r"dm([0-9]+)")


def group_room_name(gid: int, rid: int) -> str:
    return f"g{gid}r{rid}"


def dm_room_name(cid: int) -> str:
    return f"dm{cid}"


def parse_room_name(name: str) -> tuple[str, int, int] | None:
    if m := _DM_ROOM.fullmatch(name):
        return "dm", int(m[1]), 0
    if m := _GROUP_ROOM.fullmatch(name):
        return "group", int(m[1]), int(m[2])
    return None


_tasks: set[asyncio.Task] = set()


def background(coro) -> None:
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


class Server:
    def __init__(self, cfg: Config, version: str):
        self.cfg = cfg
        self.version = version
        self.lk = LiveKit(cfg.livekit_api_key, cfg.livekit_api_secret, cfg.livekit_internal_url)
        self.files = storage.open_storage(cfg)
        self.hub = Hub(self.room_audience)
        self.rl = RateLimiter()
        self.upload_locks: dict[int, asyncio.Lock] = {}
        self.updater = Updater(cfg, version, self.hub)

    async def room_members(self, room: str) -> list[int]:
        """Raises on database errors, so a failed lookup never removes anyone from a room."""
        parsed = parse_room_name(room)
        if parsed is None:
            return []
        kind, a, _ = parsed
        try:
            if kind == "dm":
                return await chat.channel_members(a)
            return (await groups.group_by_id(a))["members"]
        except NotFound:
            return []

    async def room_audience(self, room: str) -> list[int]:
        try:
            return await self.room_members(room)
        except Exception:
            log.exception("room audience room=%s", room)
            return []

    def can_see_room(self, uid: int):
        async def check(room: str) -> bool:
            return uid in await self.room_audience(room)

        return check

    def client_ip(self, request: Request) -> str:
        if self.cfg.trust_proxy and (xff := request.headers.get("x-forwarded-for")):
            # The proxy appends the address it sees; everything before it comes from the client.
            return xff.rsplit(",", 1)[-1].strip()
        return request.client.host if request.client else ""

    def livekit_url(self, request: Request) -> str:
        if self.cfg.livekit_public_url:
            return self.cfg.livekit_public_url
        h = request.headers
        scheme, host = request.url.scheme, h.get("host", "")
        if self.cfg.trust_proxy:
            scheme = h.get("x-forwarded-proto", scheme).split(",")[0].strip()
            host = h.get("x-forwarded-host", host).split(",")[0].strip()
        if scheme == "https":
            # The reverse proxy sends /rtc on the same domain to LiveKit.
            return f"wss://{host}"
        hostname = host if host.endswith("]") else host.rsplit(":", 1)[0]
        return f"ws://{hostname}:7880"

    def limit(self, key: str, burst: float, per_minute: float, message: str) -> None:
        if not self.rl.allow(key, burst, per_minute):
            raise ApiError(429, "rate_limited", message)


async def current_user(request: Request) -> dict:
    h = request.headers.get("authorization", "")
    token = h.removeprefix("Bearer ") if h.startswith("Bearer ") else ""
    if not token:
        raise ApiError(401, "unauthorized", "Sign-in required")
    try:
        u = await users.user_by_token(token)
    except NotFound:
        raise ApiError(401, "unauthorized", "Session is invalid or expired") from None
    request.state.token = token
    return u


async def admin_user(request: Request) -> dict:
    u = await current_user(request)
    if not u["is_admin"]:
        raise ApiError(403, "forbidden", "Administrators only")
    return u
