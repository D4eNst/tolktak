from tortoise.backends.base.client import BaseDBAsyncClient
from tortoise.exceptions import IntegrityError
from tortoise.transactions import in_transaction

from .. import db
from ..db import CONN
from ..errors import Conflict, FileMissing, Forbidden, NotFound
from ..models import Channel, ChannelMember, Message, MessageFile, Reaction, TextChannel, User
from . import files, groups, now, search, users
from .files import file_dict


def channel_summary(cid: int, kind: str, peer_id: int = 0, group_id: int = 0, last_message: dict | None = None,
                    last_read_id: int = 0, unread: int = 0, history_version: int = 0) -> dict:  # fmt: skip
    out: dict = {"id": cid, "kind": kind}
    if peer_id:
        out["peer_id"] = peer_id
    if group_id:
        out["group_id"] = group_id
    out |= {
        "last_message": last_message,
        "last_read_id": last_read_id,
        "unread": unread,
        "history_version": history_version,
    }
    return out


def dm_key(a: int, b: int) -> str:
    if a > b:
        a, b = b, a
    return f"{a}:{b}"


async def ensure_dm(a: int, b: int) -> tuple[int, bool]:
    if a == b:
        raise Forbidden
    key = dm_key(a, b)
    try:
        async with in_transaction(CONN) as tx:
            ch = await Channel.filter(dm_key=key).using_db(tx).first()
            if ch is not None:
                return ch.id, False
            if await User.filter(id__in=[a, b]).using_db(tx).count() != 2:
                raise NotFound
            ch = await Channel.create(kind="dm", dm_key=key, created_at=now(), using_db=tx)
            await ChannelMember.bulk_create(
                [ChannelMember(channel_id=ch.id, user_id=a), ChannelMember(channel_id=ch.id, user_id=b)], using_db=tx
            )
            return ch.id, True
    except IntegrityError:
        # A concurrent request created it first.
        ch = await Channel.filter(dm_key=key).first()
        if ch is None:
            raise
        return ch.id, False


async def is_channel_member(cid: int, uid: int) -> bool:
    return bool(await db.rows("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?", [cid, uid]))


async def channel_members(cid: int) -> list[int]:
    return [r["user_id"] for r in await db.rows("SELECT user_id FROM channel_members WHERE channel_id = ?", [cid])]


async def dm_peer(cid: int, me: int) -> int:
    ch = await Channel.filter(id=cid).first()
    if ch is None or ch.kind != "dm":
        raise NotFound
    peer = await ChannelMember.filter(channel_id=cid, user_id__not=me).values_list("user_id", flat=True)
    if not peer:
        raise NotFound
    return peer[0]  # ty: ignore[invalid-return-type]


async def list_channels(uid: int) -> list[dict]:
    async with db.read_transaction() as tx:
        found = await db.rows(
            """
            SELECT c.id, c.kind, c.history_version, cm.last_read_id,
              COALESCE((SELECT m2.user_id FROM channel_members m2 WHERE m2.channel_id = c.id AND m2.user_id != ?
                        AND c.kind = 'dm'), 0) AS peer_id,
              COALESCE((SELECT t.group_id FROM text_channels t WHERE t.channel_id = c.id), 0) AS group_id,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.id > cm.last_read_id
                 AND m.author_id != ? AND m.deleted = 0) AS unread,
              COALESCE((SELECT MAX(id) FROM messages m WHERE m.channel_id = c.id AND m.deleted = 0), 0) AS last_id
            FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
            WHERE cm.user_id = ?
            """,
            [uid, uid, uid],
            tx,
        )
        last = {m["id"]: m for m in await messages_by_ids([r["last_id"] for r in found if r["last_id"]], tx)}
        return [
            channel_summary(
                r["id"],
                r["kind"],
                r["peer_id"],
                r["group_id"],
                last.get(r["last_id"]),
                r["last_read_id"],
                r["unread"],
                r["history_version"],
            )
            for r in found
        ]


async def read_state(cid: int, uid: int, c: db.BaseDBAsyncClient | None = None) -> dict:
    found = await db.rows(
        "SELECT cm.channel_id, cm.last_read_id AS message_id, c.history_version, "
        "(SELECT COUNT(*) FROM messages m WHERE m.channel_id = cm.channel_id "
        "AND m.id > cm.last_read_id AND m.author_id != cm.user_id AND m.deleted = 0) AS unread "
        "FROM channel_members cm JOIN channels c ON c.id = cm.channel_id "
        "WHERE cm.channel_id = ? AND cm.user_id = ?",
        [cid, uid],
        c,
    )
    if not found:
        raise NotFound
    return found[0]


async def mark_read(cid: int, uid: int, message_id: int) -> dict:
    async with in_transaction(CONN) as tx:
        changed = await db.execute(
            "UPDATE channel_members SET last_read_id = CASE WHEN last_read_id > ? THEN last_read_id ELSE ? END "
            "WHERE channel_id = ? AND user_id = ? "
            "AND EXISTS (SELECT 1 FROM messages WHERE channel_id = ? AND id = ?)",
            [message_id, message_id, cid, uid, cid, message_id],
            tx,
        )
        if not changed:
            raise NotFound
    return await read_state(cid, uid)


_COLUMNS = "id, channel_id, author_id, nonce, text, created_at, edited_at, deleted, reply_to, pinned_at, revision"


def _message(m: dict) -> dict:
    deleted = m["deleted"] == 1
    return {
        "id": m["id"],
        "channel_id": m["channel_id"],
        "author_id": m["author_id"],
        "nonce": m["nonce"],
        "text": "" if deleted else m["text"],
        "created_at": m["created_at"],
        "edited_at": m["edited_at"],
        "deleted": deleted,
        "reply_to": m["reply_to"],
        "attachments": [],
        "reactions": [],
        "pinned_at": None if deleted else m["pinned_at"],
        "revision": m["revision"],
    }


async def _hydrate(ms: list[dict], c: BaseDBAsyncClient | None = None) -> list[dict]:
    if not ms:
        return ms
    by_id = {m["id"]: m for m in ms}
    ids = list(by_id)
    for r in await db.rows(
        "SELECT mf.message_id, f.id, f.name, f.mime, f.size, f.width, f.height FROM message_files mf "
        f"JOIN files f ON f.id = mf.file_id WHERE mf.message_id IN ({db.marks(len(ids))}) ORDER BY mf.position",
        ids,
        c,
    ):
        by_id[r["message_id"]]["attachments"].append(file_dict(r))
    reactions = await db.rows(
        f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({db.marks(len(ids))}) "
        "ORDER BY created_at",
        ids,
        c,
    )
    for r in reactions:
        m = by_id[r["message_id"]]
        if m["deleted"]:
            continue
        emoji, uid = r["emoji"], r["user_id"]
        for x in m["reactions"]:
            if x["emoji"] == emoji:
                x["users"].append(uid)
                break
        else:
            m["reactions"].append({"emoji": emoji, "users": [uid]})
    reply_ids = list({m["reply_to"] for m in ms if m["reply_to"] is not None and not m["deleted"]})
    if reply_ids:
        previews = {}
        for r in await db.rows(
            "SELECT id, author_id, text, deleted, revision, "
            "(SELECT COUNT(*) FROM message_files WHERE message_id = messages.id) AS attachments "
            f"FROM messages WHERE id IN ({db.marks(len(reply_ids))})",
            reply_ids,
            c,
        ):
            deleted = r["deleted"] == 1
            text = r["text"]
            if deleted:
                text = ""
            elif len(text) > 160:
                text = text[:160] + "…"
            previews[r["id"]] = {
                "id": r["id"],
                "author_id": r["author_id"],
                "text": text,
                "deleted": deleted,
                "attachments": 0 if deleted else r["attachments"],
                "revision": r["revision"],
            }
        for m in ms:
            if m["reply_to"] is not None and m["reply_to"] in previews:
                m["reply"] = previews[m["reply_to"]]
    return ms


async def _collect(where: str, values: list, c: BaseDBAsyncClient | None = None) -> list[dict]:
    found = await db.rows(f"SELECT {_COLUMNS} FROM messages WHERE {where}", values, c)
    return await _hydrate([_message(m) for m in found], c)


async def messages_by_ids(ids: list[int], c: BaseDBAsyncClient | None = None) -> list[dict]:
    if not ids:
        return []
    return await _collect(f"id IN ({db.marks(len(ids))})", list(ids), c)


async def message_by_id(mid: int, c: BaseDBAsyncClient | None = None) -> dict:
    found = await _collect("id = ?", [mid], c)
    if not found:
        raise NotFound
    return found[0]


async def _lock_history(cid: int, c: BaseDBAsyncClient) -> None:
    # Group mutations take this same lock before touching channels or membership.
    group = await db.rows("SELECT group_id FROM text_channels WHERE channel_id = ?", [cid], c)
    if group:
        await groups.lock_group(group[0]["group_id"], c)
    found = await db.rows("UPDATE channels SET history_version = history_version WHERE id = ? RETURNING id", [cid], c)
    if not found:
        raise NotFound


async def _advance_history(cid: int, c: BaseDBAsyncClient) -> int:
    found = await db.rows(
        "UPDATE channels SET history_version = history_version + 1 WHERE id = ? RETURNING history_version", [cid], c
    )
    return found[0]["history_version"]


async def _require_member(cid: int, uid: int, c: BaseDBAsyncClient) -> None:
    if not await ChannelMember.filter(channel_id=cid, user_id=uid).using_db(c).exists():
        raise NotFound


async def _can_moderate(cid: int, uid: int, c: BaseDBAsyncClient) -> bool:
    found = await db.rows(
        "SELECT g.owner_id, gm.role FROM text_channels t JOIN groups g ON g.id = t.group_id "
        "LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? WHERE t.channel_id = ?",
        [uid, cid],
        c,
    )
    return not found or (found[0]["owner_id"] == uid or found[0]["role"] == "mod")


async def _lock_message(mid: int, uid: int, c: BaseDBAsyncClient) -> Message:
    found = await Message.filter(id=mid).using_db(c).first()
    if found is None:
        raise NotFound
    await _lock_history(found.channel_id, c)
    await _require_member(found.channel_id, uid, c)
    found = await Message.filter(id=mid).using_db(c).first()
    if found is None or found.deleted:
        raise NotFound
    return found


async def create_message(cid: int, author: int, nonce: str, text: str, reply_to: int, attachments: list[str]):
    """A retried send with the same nonce returns the original message and created=False."""
    created = False
    try:
        async with in_transaction(CONN) as tx:
            await _lock_history(cid, tx)
            await _require_member(cid, author, tx)
            existing = await Message.filter(author_id=author, nonce=nonce).using_db(tx).first()
            if existing is not None:
                if existing.channel_id != cid:
                    raise Conflict
                mid = existing.id
            else:
                reply = None
                if reply_to > 0:
                    target = await Message.filter(id=reply_to).using_db(tx).first()
                    if target is None or target.channel_id != cid:
                        raise NotFound
                    reply = reply_to
                if attachments:
                    owners = {file["id"]: file["uploader_id"] for file in await files.lock_files(attachments, tx)}
                    if any(owner != author for owner in owners.values()):
                        raise Forbidden
                    if any(f not in owners for f in attachments):
                        raise FileMissing
                revision = await _advance_history(cid, tx)
                m = await Message.create(
                    channel_id=cid, author_id=author, nonce=nonce, text=text, created_at=now(), reply_to=reply,
                    revision=revision, using_db=tx,
                )  # fmt: skip
                mid = m.id
                created = True
                await search.replace(mid, text, tx)
                if attachments:
                    await MessageFile.bulk_create(
                        [MessageFile(message_id=mid, file_id=f, position=i) for i, f in enumerate(attachments)],
                        using_db=tx,
                    )
            result = await message_by_id(mid, tx)
    except IntegrityError:
        # Same-channel nonce retries already serialize on the channel lock.
        raise Conflict from None
    return result, created


async def list_messages(cid: int, before: int, after: int, limit: int) -> list[dict]:
    if after > 0:
        return await _collect("channel_id = ? AND id > ? ORDER BY id LIMIT ?", [cid, after, limit])
    if before > 0:
        out = await _collect("channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?", [cid, before, limit])
    else:
        out = await _collect("channel_id = ? ORDER BY id DESC LIMIT ?", [cid, limit])
    out.reverse()
    return out


async def _message_profiles(messages: list[dict], c: BaseDBAsyncClient) -> list[dict]:
    authors = {message["author_id"] for message in messages}
    authors.update(message["reply"]["author_id"] for message in messages if message.get("reply"))
    return await users.profiles_by_ids(sorted(authors), c)


async def _history_ids(cid: int, clause: str, values: list[int], limit: int, c: BaseDBAsyncClient) -> list[int]:
    found = await db.rows(
        f"SELECT id FROM messages WHERE channel_id = ? AND deleted = 0 {clause} LIMIT ?", [cid, *values, limit], c
    )
    return [m["id"] for m in found]


async def history_page(cid: int, uid: int, before: int = 0, after: int | None = None, around: int = 0,
                       limit: int = 100) -> dict:  # fmt: skip
    async with db.read_transaction() as tx:
        read = await read_state(cid, uid, tx)
        if around:
            target = await db.rows(
                "SELECT id FROM messages WHERE channel_id = ? AND id = ? AND deleted = 0", [cid, around], tx
            )
            if not target:
                raise NotFound
            left_limit = (limit - 1) // 2 + 1
            left = await _history_ids(cid, "AND id <= ? ORDER BY id DESC", [around], left_limit, tx)
            right = await _history_ids(cid, "AND id > ? ORDER BY id", [around], limit - len(left), tx)
            if len(right) < limit - len(left):
                left = await _history_ids(cid, "AND id <= ? ORDER BY id DESC", [around], limit - len(right), tx)
            ids = [*reversed(left), *right]
        elif after is not None:
            ids = await _history_ids(cid, "AND id > ? ORDER BY id", [after], limit, tx)
        else:
            clause = "AND id < ? ORDER BY id DESC" if before else "ORDER BY id DESC"
            ids = list(reversed(await _history_ids(cid, clause, [before] if before else [], limit, tx)))

        first, last = (ids[0], ids[-1]) if ids else (None, None)
        if ids:
            bounds = await db.rows(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE channel_id = ? AND deleted = 0 AND id < ?) AS older, "
                "EXISTS(SELECT 1 FROM messages WHERE channel_id = ? AND deleted = 0 AND id > ?) AS newer",
                [cid, first, cid, last],
                tx,
            )
        elif before or after is not None:
            bounds = await db.rows(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE channel_id = ? AND deleted = 0 AND id <= ?) AS older, "
                "EXISTS(SELECT 1 FROM messages WHERE channel_id = ? AND deleted = 0 AND id >= ?) AS newer",
                [cid, after or 0, cid, before or (1 << 63) - 1],
                tx,
            )
        else:
            bounds = [{"older": False, "newer": False}]
        ms = await messages_by_ids(ids, tx)
        ms.sort(key=lambda m: m["id"])
        return {
            "messages": ms,
            "users": await _message_profiles(ms, tx),
            "first_id": first,
            "last_id": last,
            "has_before": bool(bounds[0]["older"]),
            "has_after": bool(bounds[0]["newer"]),
            "history_version": read["history_version"],
            "read": {"message_id": read["message_id"], "unread": read["unread"]},
        }


async def message_changes(cid: int, uid: int, since: int, limit: int = 100) -> dict:
    async with db.read_transaction() as tx:
        read = await read_state(cid, uid, tx)
        if since > read["history_version"]:
            raise Conflict
        found = await db.rows(
            "SELECT id FROM messages WHERE channel_id = ? AND revision > ? ORDER BY revision, id LIMIT ?",
            [cid, since, limit + 1],
            tx,
        )
        ms = await messages_by_ids([m["id"] for m in found[:limit]], tx)
        ms.sort(key=lambda m: (m["revision"], m["id"]))
        return {
            "messages": ms,
            "users": await _message_profiles(ms, tx),
            "history_version": read["history_version"],
            "complete": len(found) <= limit,
            "read": {"message_id": read["message_id"], "unread": read["unread"]},
        }


async def search_messages(cid: int, q: str, limit: int) -> list[dict]:
    found = (
        await Message.filter(channel_id=cid, deleted=0, text__icontains=q)
        .order_by("-id")
        .limit(limit)
        .values_list("id", flat=True)
    )
    out = await messages_by_ids(list(found))  # ty: ignore[invalid-argument-type]
    out.sort(key=lambda m: m["id"], reverse=True)
    return out


async def _history_head(cid: int, uid: int, c: BaseDBAsyncClient) -> int:
    found = await db.rows(
        "SELECT c.history_version FROM channel_members cm JOIN channels c ON c.id = cm.channel_id "
        "WHERE cm.channel_id = ? AND cm.user_id = ?",
        [cid, uid],
        c,
    )
    if not found:
        raise NotFound
    return found[0]["history_version"]


async def search_page(cid: int, uid: int, query: str, before: int = 0, limit: int = 50) -> dict:
    async with db.read_transaction() as tx:
        version = await _history_head(cid, uid, tx)
        if before and not await Message.filter(channel_id=cid, id=before).using_db(tx).exists():
            raise NotFound
        ids = await search.candidates(cid, query, before or (1 << 63) - 1, limit + 1, tx)
        ms = await messages_by_ids(ids[:limit], tx)
        ms.sort(key=lambda m: m["id"], reverse=True)
        return {
            "messages": ms,
            "users": await _message_profiles(ms, tx),
            "has_more": len(ids) > limit,
            "next_before": ms[-1]["id"] if len(ids) > limit else None,
            "history_version": version,
        }


async def attachments_in(cids: list[int]) -> list[str]:
    found = await db.rows(
        "SELECT mf.file_id FROM message_files mf JOIN messages m ON m.id = mf.message_id "
        f"WHERE m.channel_id IN ({db.marks(len(cids))})",
        cids,
    )
    return [r["file_id"] for r in found]


async def pinned_messages(cid: int, c: BaseDBAsyncClient | None = None) -> list[dict]:
    return await _collect(
        "channel_id = ? AND deleted = 0 AND pinned_at IS NOT NULL ORDER BY pinned_at DESC, id DESC LIMIT 50", [cid], c
    )


async def pinned_page(cid: int, uid: int) -> dict:
    async with db.read_transaction() as tx:
        version = await _history_head(cid, uid, tx)
        ms = await pinned_messages(cid, tx)
        return {"messages": ms, "users": await _message_profiles(ms, tx), "history_version": version}


async def edit_message(mid: int, author: int, text: str) -> dict:
    async with in_transaction(CONN) as tx:
        m = await _lock_message(mid, author, tx)
        if m.author_id != author:
            raise Forbidden
        if m.text != text:
            revision = await _advance_history(m.channel_id, tx)
            await Message.filter(id=mid).using_db(tx).update(text=text, edited_at=now(), revision=revision)
            await search.replace(mid, text, tx)
        return await message_by_id(mid, tx)


async def delete_message(mid: int, uid: int) -> dict:
    async with in_transaction(CONN) as tx:
        m = await _lock_message(mid, uid, tx)
        if m.author_id != uid:
            group = await TextChannel.filter(channel_id=m.channel_id).using_db(tx).exists()
            if not group or not await _can_moderate(m.channel_id, uid, tx):
                raise Forbidden
        revision = await _advance_history(m.channel_id, tx)
        await Message.filter(id=mid).using_db(tx).update(text="", pinned_at=None, deleted=1, revision=revision)
        await db.execute("DELETE FROM message_search WHERE message_id = ?", [mid], tx)
        await db.execute("DELETE FROM message_files WHERE message_id = ?", [mid], tx)
        await db.execute("DELETE FROM reactions WHERE message_id = ?", [mid], tx)
        return await message_by_id(mid, tx)


async def toggle_reaction(mid: int, uid: int, emoji: str) -> dict:
    async with in_transaction(CONN) as tx:
        m = await _lock_message(mid, uid, tx)
        removed = await db.execute(
            "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", [mid, uid, emoji], tx
        )
        if not removed:
            distinct = await Reaction.filter(message_id=mid).using_db(tx).distinct().values_list("emoji", flat=True)
            if emoji not in distinct and len(set(distinct)) >= 20:
                raise Conflict
            await Reaction.create(message_id=mid, user_id=uid, emoji=emoji, created_at=now(), using_db=tx)
        revision = await _advance_history(m.channel_id, tx)
        await Message.filter(id=mid).using_db(tx).update(revision=revision)
        return await message_by_id(mid, tx)


async def set_pinned(mid: int, uid: int, pinned: bool) -> dict:
    async with in_transaction(CONN) as tx:
        m = await _lock_message(mid, uid, tx)
        if not await _can_moderate(m.channel_id, uid, tx):
            raise Forbidden
        if (m.pinned_at is not None) != pinned:
            revision = await _advance_history(m.channel_id, tx)
            await Message.filter(id=mid).using_db(tx).update(pinned_at=now() if pinned else None, revision=revision)
        return await message_by_id(mid, tx)


async def group_of_channel(cid: int) -> int:
    gid = await TextChannel.filter(channel_id=cid).values_list("group_id", flat=True)
    return gid[0] if gid else 0  # ty: ignore[invalid-return-type]
