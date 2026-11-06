from contextlib import asynccontextmanager

from tortoise.transactions import in_transaction

from .. import db
from ..errors import Conflict, Forbidden, NotFound
from . import groups, now, users

SOURCES = ("microphone", "camera", "screen", "entry")


async def room_info(rid: int, uid: int | None, c: db.BaseDBAsyncClient) -> dict:
    found = await db.rows(
        "SELECT id, group_id, moderation_version, call_id, call_active FROM rooms WHERE id = ?", [rid], c
    )
    if not found:
        raise NotFound
    room = found[0]
    if uid is not None and not await db.rows(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", [room["group_id"], uid], c
    ):
        raise NotFound
    return room


async def _actor(room: dict, uid: int, target: int | None, tx: db.BaseDBAsyncClient) -> None:
    await groups._require_moderator(room["group_id"], uid, tx)
    if target is None:
        return
    found = await db.rows(
        "SELECT g.owner_id, actor.role AS actor_role, target.role AS target_role "
        "FROM groups g JOIN group_members actor ON actor.group_id = g.id AND actor.user_id = ? "
        "LEFT JOIN group_members target ON target.group_id = g.id AND target.user_id = ? WHERE g.id = ?",
        [uid, target, room["group_id"]],
        tx,
    )
    if target == uid or target == found[0]["owner_id"]:
        raise Forbidden
    if found[0]["owner_id"] != uid and found[0]["target_role"] == "mod":
        raise Forbidden


@asynccontextmanager
async def _write(rid: int, actor: int | None = None, target: int | None = None):
    async with in_transaction(db.CONN) as tx:
        room = await room_info(rid, None, tx)
        await groups.lock_group(room["group_id"], tx)
        room = await room_info(rid, None, tx)
        if actor is not None:
            await _actor(room, actor, target, tx)
        yield room, tx


async def _advance(rid: int, tx: db.BaseDBAsyncClient) -> None:
    await db.execute("UPDATE rooms SET moderation_version = moderation_version + 1 WHERE id = ?", [rid], tx)


async def _rules(room: dict, uid: int, tx: db.BaseDBAsyncClient) -> list[dict]:
    return await db.rows(
        "SELECT id, room_id, user_id, source, duration, expires_at, call_id, created_by FROM voice_rules "
        "WHERE room_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?) "
        "AND (duration != 'call' OR (call_id = ? AND ? = 1)) ORDER BY id",
        [room["id"], uid, now(), room["call_id"], room["call_active"]],
        tx,
    )


async def snapshot(rid: int, uid: int, authorize: bool = True) -> dict:
    async with db.read_transaction() as tx:
        room = await room_info(rid, uid if authorize else None, tx)
        rules = await _rules(room, uid, tx)
        allowed = dict.fromkeys(SOURCES, True)
        for rule in rules:
            allowed[rule["source"]] = False
        return {
            "room_id": rid,
            "user_id": uid,
            "rules": rules,
            "allowed": allowed,
            "moderation_version": room["moderation_version"],
            "call_id": room["call_id"] if room["call_active"] else None,
        }


async def rule_page(rid: int, uid: int, after: int = 0, limit: int = 100) -> dict:
    async with db.read_transaction() as tx:
        room = await room_info(rid, uid, tx)
        await _actor(room, uid, None, tx)
        found = await db.rows(
            "SELECT id, room_id, user_id, source, duration, expires_at, call_id, created_by FROM voice_rules "
            "WHERE room_id = ? AND id > ? AND (expires_at IS NULL OR expires_at > ?) "
            "AND (duration != 'call' OR (call_id = ? AND ? = 1)) ORDER BY id LIMIT ?",
            [rid, after, now(), room["call_id"], room["call_active"], limit + 1],
            tx,
        )
        rules = found[:limit]
        ids = sorted({r[key] for r in rules for key in ("user_id", "created_by")})
        return {
            "rules": rules,
            "users": await users.profiles_by_ids(ids, tx),
            "has_more": len(found) > limit,
            "next_after": rules[-1]["id"] if len(found) > limit else None,
            "moderation_version": room["moderation_version"],
            "call_id": room["call_id"] if room["call_active"] else None,
        }


async def change_rule(
    rid: int, actor: int, uid: int, source: str, duration: str | None, seconds: int | None = None
) -> bool:
    async with _write(rid, actor, uid) as (room, tx):
        if duration is None:
            changed = await db.rows(
                "DELETE FROM voice_rules WHERE room_id = ? AND user_id = ? AND source = ? RETURNING id",
                [rid, uid, source],
                tx,
            )
            if not changed:
                return False
        else:
            if not await db.rows(
                "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", [room["group_id"], uid], tx
            ):
                raise NotFound
            if duration == "call" and not room["call_active"]:
                raise Conflict
            expires = now() + seconds * 1000 if duration == "time" and seconds is not None else None
            if expires is not None and expires >= 1 << 63:
                raise Conflict
            call_id = room["call_id"] if duration == "call" else None
            old = await db.rows(
                "SELECT duration, expires_at, call_id FROM voice_rules "
                "WHERE room_id = ? AND user_id = ? AND source = ?",
                [rid, uid, source],
                tx,
            )
            if old and old[0] == {"duration": duration, "expires_at": expires, "call_id": call_id}:
                return False
            await db.execute(
                "INSERT INTO voice_rules (room_id, user_id, source, duration, expires_at, call_id, created_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, user_id, source) DO UPDATE SET "
                "duration = excluded.duration, expires_at = excluded.expires_at, call_id = excluded.call_id, "
                "created_by = excluded.created_by",
                [rid, uid, source, duration, expires, call_id, actor],
                tx,
            )
        await _advance(rid, tx)
        return True


async def touch(rid: int, actor: int, uid: int) -> None:
    async with _write(rid, actor, uid) as (_, tx):
        await _advance(rid, tx)


async def observe(rid: int, active: bool | None = None) -> list[tuple[int, str]]:
    async with _write(rid) as (room, tx):
        changed = active is not None and bool(room["call_active"]) != active
        if changed:
            await db.execute(
                "UPDATE rooms SET call_active = ?, call_id = call_id + ? WHERE id = ?",
                [int(bool(active)), int(bool(active)), rid],
                tx,
            )
            room = await room_info(rid, None, tx)
        expired = await db.rows(
            "DELETE FROM voice_rules WHERE room_id = ? AND ((expires_at IS NOT NULL AND expires_at <= ?) "
            "OR (duration = 'call' AND (call_id != ? OR ? = 0))) RETURNING user_id, source",
            [rid, now(), room["call_id"], room["call_active"]],
            tx,
        )
        if changed or expired:
            await _advance(rid, tx)
        return [(r["user_id"], r["source"]) for r in expired]
