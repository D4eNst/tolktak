import asyncio
import base64
import hashlib
import hmac
import secrets
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from argon2.low_level import Type, hash_secret_raw
from tortoise.exceptions import IntegrityError
from tortoise.transactions import in_transaction

from .. import db
from ..db import CONN
from ..errors import ApiError, Conflict, Forbidden, NotFound
from ..models import Invite, Session, User
from . import files, now

AVATAR_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8e8c99"]

# RFC 9106 memory-constrained Argon2id parameters.
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


# Limit Argon2 to two off-loop jobs at 64 MB each.
_hashing = ThreadPoolExecutor(max_workers=2, thread_name_prefix="argon2")


async def hash_password(password: str) -> str:
    return await asyncio.get_running_loop().run_in_executor(_hashing, _hash_password, password)


async def check_password(encoded: str, password: str) -> bool:
    return await asyncio.get_running_loop().run_in_executor(_hashing, _check_password, encoded, password)


_USER_COLUMNS = "id, username, display_name, color, is_admin, created_at, avatar, about, status, profile_revision"


def user_dict(u: User | dict) -> dict:
    g = u.__getitem__ if isinstance(u, dict) else u.__getattribute__
    return {
        "id": g("id"),
        "username": g("username"),
        "display_name": g("display_name"),
        "color": g("color"),
        "is_admin": g("is_admin") == 1,
        "created_at": g("created_at"),
        "avatar": g("avatar"),
        "about": g("about"),
        "status": g("status"),
        "profile_revision": g("profile_revision"),
    }


async def count_users() -> int:
    return await User.all().count()


async def create_user(
    username: str, display_name: str, password: str, invite_code: str, registration: str = "open"
) -> dict:
    """The first user becomes the admin."""
    pw_hash = await hash_password(password)
    try:
        async with in_transaction(CONN) as tx:
            if db.is_postgres(tx):
                # Serialize bootstrap policy and first-admin selection.
                await db.execute("SELECT pg_advisory_xact_lock(7461)", [], tx)
            count = await User.all().using_db(tx).count()
            if count and (registration == "closed" or registration == "invite" and not invite_code):
                raise Forbidden
            if count and registration == "invite":
                n = await db.execute(
                    "UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND expires_at > ?",
                    [invite_code, now()],
                    tx,
                )
                if n != 1:
                    raise Forbidden
            if await User.filter(username__iexact=username).using_db(tx).exists():
                raise Conflict
            u = await User.create(
                username=username, display_name=display_name, password_hash=pw_hash,
                username_folded=username.casefold(), display_name_folded=display_name.casefold(),
                color=AVATAR_COLORS[count % len(AVATAR_COLORS)], is_admin=1 if count == 0 else 0,
                created_at=now(), using_db=tx,
            )  # fmt: skip
    except IntegrityError as e:
        raise Conflict from e
    return user_dict(await User.get(id=u.id))


async def authenticate(username: str, password: str) -> dict:
    u = await User.filter(username__iexact=username).first()
    if u is None:
        # Match password work for missing users.
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


async def profiles_by_ids(ids: list[int], c: db.BaseDBAsyncClient | None = None) -> list[dict]:
    if not ids:
        return []
    found = await db.rows(f"SELECT {_USER_COLUMNS} FROM users WHERE id IN ({db.marks(len(ids))}) ORDER BY id", ids, c)
    return [user_dict(u) for u in found]


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
    _user_cache.pop(uid, None)
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


# App writes invalidate these caches. Direct session deletion is checked within a minute.
_session_cache: dict[bytes, list[int]] = {}  # token hash -> [session id, user id, last seen]
_user_cache: dict[int, dict] = {}
_CACHE_MAX = 20_000


def reset_caches() -> None:
    _session_cache.clear()
    _user_cache.clear()


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


async def delete_idle_sessions() -> None:
    """Ends sessions not used for 90 days; one in use updates last_seen every minute."""
    await Session.filter(last_seen__lt=now() - 90 * 24 * 60 * 60 * 1000).delete()


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
    async with in_transaction(CONN) as tx:
        await db.execute("UPDATE users SET profile_revision = profile_revision WHERE id = ?", [uid], tx)
        if fields.get("avatar"):
            await files.require_avatar(fields["avatar"], uid, tx)
        u = await User.filter(id=uid).using_db(tx).first()
        if u is None:
            raise NotFound
        changed = {k: v for k, v in fields.items() if getattr(u, k) != v}
        if changed:
            if "display_name" in changed:
                changed["display_name_folded"] = changed["display_name"].casefold()
            if "username" in changed:
                changed["username_folded"] = changed["username"].casefold()
            await User.filter(id=uid).using_db(tx).update(**changed, profile_revision=u.profile_revision + 1)
        result = await User.filter(id=uid).using_db(tx).get()
    _user_cache.pop(uid, None)
    return user_dict(result)


async def backfill_directory(tx: db.BaseDBAsyncClient) -> None:
    after = 0
    while batch := await db.rows(
        "SELECT id, username, display_name FROM users WHERE id > ? ORDER BY id LIMIT 100", [after], tx
    ):
        await tx.execute_many(
            db.sql("UPDATE users SET username_folded = ?, display_name_folded = ? WHERE id = ?", tx),
            [[u["username"].casefold(), u["display_name"].casefold(), u["id"]] for u in batch],
        )
        after = batch[-1]["id"]


def no_relation() -> dict:
    return {"state": "none", "request_id": None, "since": None}


async def backfill_contact_links(tx: db.BaseDBAsyncClient) -> None:
    owner = peer = 0
    while batch := await db.rows(
        "SELECT a.owner_id, a.contact_id, CASE WHEN a.created_at > b.created_at "
        "THEN a.created_at ELSE b.created_at END AS since FROM contacts a JOIN contacts b "
        "ON b.owner_id = a.contact_id AND b.contact_id = a.owner_id "
        "WHERE a.owner_id < a.contact_id AND (a.owner_id > ? OR (a.owner_id = ? AND a.contact_id > ?)) "
        "ORDER BY a.owner_id, a.contact_id LIMIT 100",
        [owner, owner, peer],
        tx,
    ):
        values = []
        for pair in batch:
            identity = str(uuid4())
            a, b = pair["owner_id"], pair["contact_id"]
            values.extend([[a, b, pair["since"], identity], [b, a, pair["since"], identity]])
        await tx.execute_many(
            db.sql(
                "INSERT INTO contact_links (owner_id, peer_id, state, since, request_id) "
                "VALUES (?, ?, 'contact', ?, ?)",
                tx,
            ),
            values,
        )
        owner, peer = batch[-1]["owner_id"], batch[-1]["contact_id"]
    await db.execute("UPDATE users SET contacts_version = contacts_version + 1", c=tx)


async def _contacts_head(uid: int, tx: db.BaseDBAsyncClient) -> dict:
    found = await db.rows(
        "SELECT contacts_version, (SELECT COUNT(*) FROM contact_links c WHERE c.owner_id = users.id "
        "AND c.state = 'incoming') AS incoming_count FROM users WHERE id = ?",
        [uid],
        tx,
    )
    if not found:
        raise NotFound
    return found[0]


async def contact_summary(uid: int) -> dict:
    async with db.read_transaction() as tx:
        return await _contacts_head(uid, tx)


async def _relations(uid: int, ids: list[int], tx: db.BaseDBAsyncClient) -> dict:
    if not ids:
        return {}
    found = await db.rows(
        f"SELECT peer_id, state, request_id, since FROM contact_links WHERE owner_id = ? "
        f"AND peer_id IN ({db.marks(len(ids))}) ORDER BY peer_id",
        [uid, *ids],
        tx,
    )
    return {str(row["peer_id"]): {key: row[key] for key in ("state", "request_id", "since")} for row in found}


async def _profile_relations(uid: int, profiles: list[dict], tx: db.BaseDBAsyncClient) -> dict:
    ids = [profile["id"] for profile in profiles]
    relations = await _relations(uid, ids, tx)
    return {
        "users": profiles,
        "relations": relations,
        "contact_ids": [peer for peer in ids if relations.get(str(peer), {}).get("state") == "contact"],
    }


async def directory_page(
    uid: int,
    query: str = "",
    after: int = 0,
    limit: int = 50,
    relation: str | None = None,
    exclude: list[int] | None = None,
    dialogs_only: bool = False,
) -> dict:
    async with db.read_transaction() as tx:
        head = await _contacts_head(uid, tx)
        values: list = []
        join = "JOIN contact_links c ON c.peer_id = u.id AND c.owner_id = ? AND c.state = ? " if relation else ""
        if relation:
            values.extend([uid, relation])
        elif dialogs_only:
            join = (
                "JOIN channel_members own ON own.user_id = ? "
                "JOIN channel_members peer ON peer.channel_id = own.channel_id AND peer.user_id = u.id "
                "JOIN channels dm ON dm.id = own.channel_id AND dm.kind = 'dm' "
            )
            values.append(uid)
        where = "u.id > ? "
        values.append(after)
        if dialogs_only:
            where += "AND u.id != ? "
            values.append(uid)
        if exclude:
            where += f"AND u.id NOT IN ({db.marks(len(exclude))}) "
            values.extend(exclude)
        if query:
            contains = "strpos" if db.is_postgres(tx) else "instr"
            where += f"AND ({contains}(u.username_folded, ?) > 0 OR {contains}(u.display_name_folded, ?) > 0) "
            values.extend([query.casefold(), query.casefold()])
        columns = ", ".join("u." + name.strip() for name in _USER_COLUMNS.split(","))
        found = await db.rows(
            f"SELECT {columns} FROM users u {join}WHERE {where}ORDER BY u.id LIMIT ?", [*values, limit + 1], tx
        )
        profiles = [user_dict(u) for u in found[:limit]]
        return {
            **await _profile_relations(uid, profiles, tx),
            **head,
            "has_more": len(found) > limit,
            "next_after": profiles[-1]["id"] if len(found) > limit else None,
        }


async def profile_batch(uid: int, ids: list[int]) -> dict:
    async with db.read_transaction() as tx:
        head = await _contacts_head(uid, tx)
        profiles = await profiles_by_ids(sorted(set(ids)), tx)
        return {**await _profile_relations(uid, profiles, tx), **head}


async def change_contact(uid: int, target: int, action: str, request_id: str | None = None) -> tuple[dict, bool]:
    if uid == target:
        raise Forbidden
    async with in_transaction(CONN) as tx:
        # Every pair writer takes the same user-row order, including crossed requests.
        for owner in sorted((uid, target)):
            if not await db.rows(
                "UPDATE users SET contacts_version = contacts_version WHERE id = ? RETURNING id", [owner], tx
            ):
                raise NotFound
        found = await db.rows(
            "SELECT owner_id, peer_id, state, since, request_id FROM contact_links "
            "WHERE (owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?)",
            [uid, target, target, uid],
            tx,
        )
        pair = {row["owner_id"]: row for row in found}
        current = pair.get(uid)
        conflict = ApiError(409, "contact_state", "Contact state changed; refresh and retry")
        if found:
            reverse = pair.get(target)
            complement = {"incoming": "outgoing", "outgoing": "incoming", "contact": "contact"}
            if (
                current is None
                or reverse is None
                or current["request_id"] != reverse["request_id"]
                or current["since"] != reverse["since"]
                or complement[current["state"]] != reverse["state"]
            ):
                raise conflict
        state = current["state"] if current else "none"
        changed = False
        if action == "send":
            if state == "incoming":
                raise conflict
            if state == "none":
                identity, since = str(uuid4()), now()
                await tx.execute_many(
                    db.sql(
                        "INSERT INTO contact_links (owner_id, peer_id, state, since, request_id) "
                        "VALUES (?, ?, ?, ?, ?)",
                        tx,
                    ),
                    [[uid, target, "outgoing", since, identity], [target, uid, "incoming", since, identity]],
                )
                changed = True
        else:
            if not request_id or current and current["request_id"] != request_id:
                raise conflict
            if action == "accept" and state == "contact":
                pass
            elif state == "none" and action in ("decline", "cancel", "remove"):
                pass
            elif (
                state
                != {"accept": "incoming", "decline": "incoming", "cancel": "outgoing", "remove": "contact"}[action]
            ):
                raise conflict
            else:
                if action == "accept":
                    await db.execute(
                        "UPDATE contact_links SET state = 'contact' WHERE request_id = ? "
                        "AND ((owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?))",
                        [request_id, uid, target, target, uid],
                        tx,
                    )
                else:
                    await db.execute(
                        "DELETE FROM contact_links WHERE (owner_id = ? AND peer_id = ?) "
                        "OR (owner_id = ? AND peer_id = ?)",
                        [uid, target, target, uid],
                        tx,
                    )
                changed = True
        if changed:
            await db.execute(
                "UPDATE users SET contacts_version = contacts_version + 1 WHERE id IN (?, ?)", [uid, target], tx
            )
        result = {}
        for owner, peer in ((uid, target), (target, uid)):
            relation = (await _relations(owner, [peer], tx)).get(str(peer), no_relation())
            result[owner] = {
                "user_id": peer,
                "contact": relation["state"] == "contact",
                "relation": relation,
                **await _contacts_head(owner, tx),
            }
        return result, changed
