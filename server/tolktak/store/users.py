import asyncio
import base64
import hashlib
import hmac
import secrets
from concurrent.futures import ThreadPoolExecutor

from argon2.low_level import Type, hash_secret_raw
from tortoise.exceptions import IntegrityError
from tortoise.transactions import in_transaction

from .. import db
from ..db import CONN
from ..errors import Conflict, Forbidden, NotFound
from ..models import Invite, Session, User
from . import now

AVATAR_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8e8c99"]

# Argon2id parameters (RFC 9106 second recommended option, memory-constrained).
ARGON_TIME = 3
ARGON_MEMORY = 64 * 1024
ARGON_THREADS = 2
ARGON_KEY_LEN = 32

_DUMMY_HASH = "argon2id$3$65536$2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s + "=" * (-len(s) % 4), validate=True)


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hash_secret_raw(
        password.encode(), salt, time_cost=ARGON_TIME, memory_cost=ARGON_MEMORY,
        parallelism=ARGON_THREADS, hash_len=ARGON_KEY_LEN, type=Type.ID,
    )  # fmt: skip
    return f"argon2id${ARGON_TIME}${ARGON_MEMORY}${ARGON_THREADS}${_b64(salt)}${_b64(key)}"


def _check_password(encoded: str, password: str) -> bool:
    parts = encoded.split("$")
    if len(parts) != 6 or parts[0] != "argon2id":
        return False
    try:
        t, m, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, want = _unb64(parts[4]), _unb64(parts[5])
        got = hash_secret_raw(
            password.encode(), salt, time_cost=t, memory_cost=m, parallelism=p, hash_len=len(want), type=Type.ID
        )
    except Exception:
        return False
    return hmac.compare_digest(got, want)


# Hashing takes about 50 ms of CPU and 64 MB: off the event loop, two at a time,
# so a burst of logins waits in line instead of taking all memory.
_hashing = ThreadPoolExecutor(max_workers=2, thread_name_prefix="argon2")


async def hash_password(password: str) -> str:
    return await asyncio.get_running_loop().run_in_executor(_hashing, _hash_password, password)


async def check_password(encoded: str, password: str) -> bool:
    return await asyncio.get_running_loop().run_in_executor(_hashing, _check_password, encoded, password)


_USER_COLUMNS = "id, username, display_name, color, is_admin, created_at, avatar, about, status"


def user_dict(u: User | dict) -> dict:
    g = u.__getitem__ if isinstance(u, dict) else u.__getattribute__
    return {
        "id": g("id"),
        "username": g("username"),
        "display_name": g("display_name"),
        "color": g("color"),
        "is_admin": g("is_admin") == 1,
        "created_at": g("created_at"),
        "avatar": g("avatar"),  # file id, "" = coloured initial
        "about": g("about"),
        "status": g("status"),  # custom status line
    }


async def count_users() -> int:
    return await User.all().count()


async def create_user(username: str, display_name: str, password: str, invite_code: str) -> dict:
    """The first user becomes the admin."""
    pw_hash = await hash_password(password)
    try:
        async with in_transaction(CONN) as tx:
            if invite_code:
                n = await db.execute(
                    "UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND expires_at > ?",
                    [invite_code, now()],
                    tx,
                )
                if n != 1:
                    raise Forbidden
            count = await User.all().using_db(tx).count()
            if await User.filter(username__iexact=username).using_db(tx).exists():
                raise Conflict
            u = await User.create(
                username=username, display_name=display_name, password_hash=pw_hash,
                color=AVATAR_COLORS[count % len(AVATAR_COLORS)], is_admin=1 if count == 0 else 0,
                created_at=now(), using_db=tx,
            )  # fmt: skip
    except IntegrityError as e:
        raise Conflict from e
    return user_dict(await User.get(id=u.id))


async def authenticate(username: str, password: str) -> dict:
    u = await User.filter(username__iexact=username).first()
    if u is None:
        # Equal time, so timing does not reveal whether the name exists.
        await check_password(_DUMMY_HASH, password)
        raise NotFound
    if not await check_password(u.password_hash, password):
        raise NotFound
    return user_dict(u)


async def user_by_id(uid: int) -> dict:
    u = await User.filter(id=uid).first()
    if u is None:
        raise NotFound
    return user_dict(u)


async def list_users() -> list[dict]:
    found = [user_dict(u) for u in await db.rows(f"SELECT {_USER_COLUMNS} FROM users")]
    found.sort(key=lambda u: u["display_name"].lower())
    return found


async def change_password(uid: int, old: str, new: str, keep_token: str) -> list[bytes]:
    """Ends every other session of the user and returns their token hashes."""
    u = await User.get(id=uid)
    if not await check_password(u.password_hash, old):
        raise Forbidden
    pw_hash = await hash_password(new)
    others = Session.filter(user_id=uid, token_hash__not=token_hash(keep_token))
    async with in_transaction(CONN) as tx:
        await User.filter(id=uid).using_db(tx).update(password_hash=pw_hash)
        ended = list(await others.using_db(tx).values_list("token_hash", flat=True))
        await others.using_db(tx).delete()
    _forget_user(uid)
    for h in ended:
        _session_cache.pop(h, None)
    return ended  # ty: ignore[invalid-return-type]


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


async def create_session(uid: int, device: str) -> str:
    """Only the token's SHA-256 is stored."""
    token = "tt_" + secrets.token_hex(32)
    t = now()
    await Session.create(user_id=uid, token_hash=token_hash(token), device=device, created_at=t, last_seen=t)
    return token


# One process does all writes, so these caches stay exact. A session deleted in the
# database directly stops working at its next last_seen update, within a minute.
_session_cache: dict[bytes, list[int]] = {}  # token hash -> [session id, user id, last seen]
_user_cache: dict[int, dict] = {}
_CACHE_MAX = 20_000


def reset_caches() -> None:
    _session_cache.clear()
    _user_cache.clear()


def _forget_user(uid: int) -> None:
    _user_cache.pop(uid, None)


async def user_by_token(token: str) -> dict:
    h = token_hash(token)
    sess = _session_cache.get(h)
    if sess is None:
        s = await Session.filter(token_hash=h).first()
        if s is None:
            raise NotFound
        if len(_session_cache) >= _CACHE_MAX:
            _session_cache.clear()
        sess = _session_cache[h] = [s.id, s.user_id, s.last_seen]
    sid, uid, last_seen = sess
    u = _user_cache.get(uid)
    if u is None:
        row = await User.filter(id=uid).first()
        if row is None:
            _session_cache.pop(h, None)
            raise NotFound
        if len(_user_cache) >= _CACHE_MAX:
            _user_cache.clear()
        u = _user_cache[uid] = user_dict(row)
    t = now()
    if last_seen < t - 60_000:
        sess[2] = t
        if not await Session.filter(id=sid).update(last_seen=t):
            _session_cache.pop(h, None)
            raise NotFound
    return dict(u)


async def delete_session(token: str) -> None:
    h = token_hash(token)
    _session_cache.pop(h, None)
    await Session.filter(token_hash=h).delete()


def invite_dict(i: Invite) -> dict:
    return {
        "code": i.code,
        "max_uses": i.max_uses,
        "uses": i.uses,
        "expires_at": i.expires_at,
        "created_at": i.created_at,
    }


async def create_invite(by: int, max_uses: int, ttl_ms: int) -> dict:
    t = now()
    inv = await Invite.create(
        code=secrets.token_hex(6).upper(), created_by=by, max_uses=max_uses, expires_at=t + ttl_ms, created_at=t
    )
    return invite_dict(inv)


async def list_invites() -> list[dict]:
    return [invite_dict(i) for i in await Invite.filter(expires_at__gt=now()).order_by("-created_at")]


async def delete_invite(code: str) -> None:
    await Invite.filter(code=code).delete()


async def update_profile(uid: int, **fields: str) -> dict:
    if fields:
        await User.filter(id=uid).update(**fields)
        _forget_user(uid)
    return await user_by_id(uid)
