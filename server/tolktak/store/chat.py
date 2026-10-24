from tortoise.exceptions import IntegrityError
from tortoise.transactions import in_transaction

from .. import db
from ..db import CONN
from ..errors import Conflict, Forbidden, NotFound
from ..models import Channel, ChannelMember, File, Message, Reaction, TextChannel, User
from . import now
from .files import files_by_ids


def channel_summary(cid: int, kind: str, peer_id: int = 0, group_id: int = 0, last_message: dict | None = None,
                    last_read_id: int = 0, unread: int = 0) -> dict:  # fmt: skip
    out: dict = {"id": cid, "kind": kind}
    if peer_id:
        out["peer_id"] = peer_id
    if group_id:
        out["group_id"] = group_id
    out |= {"last_message": last_message, "last_read_id": last_read_id, "unread": unread}
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
    found = await db.rows(
        """
        SELECT c.id, c.kind, cm.last_read_id,
          COALESCE((SELECT m2.user_id FROM channel_members m2 WHERE m2.channel_id = c.id AND m2.user_id != ?
                    AND c.kind = 'dm'), 0) AS peer_id,
          COALESCE((SELECT t.group_id FROM text_channels t WHERE t.channel_id = c.id), 0) AS group_id,
          (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.id > cm.last_read_id
             AND m.author_id != ? AND m.deleted = 0) AS unread,
          COALESCE((SELECT MAX(id) FROM messages m WHERE m.channel_id = c.id), 0) AS last_id
        FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        """,
        [uid, uid, uid],
    )
    last = {m["id"]: m for m in await messages_by_ids([r["last_id"] for r in found if r["last_id"]])}
    return [
        channel_summary(
            r["id"], r["kind"], r["peer_id"], r["group_id"], last.get(r["last_id"]), r["last_read_id"], r["unread"]
        )
        for r in found
    ]


async def mark_read(cid: int, uid: int, message_id: int) -> None:
    await db.execute(
        "UPDATE channel_members SET last_read_id = CASE WHEN last_read_id > ? THEN last_read_id ELSE ? END "
        "WHERE channel_id = ? AND user_id = ?",
        [message_id, message_id, cid, uid],
    )


def _split(ids: str) -> list[str]:
    return ids.split(",") if ids else []


_COLUMNS = "id, channel_id, author_id, nonce, text, created_at, edited_at, deleted, reply_to, attachments, pinned_at"


def _message(m: dict) -> dict:
    deleted = m["deleted"] == 1
    out = {
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
    }
    out["_files"] = [] if deleted else _split(m["attachments"])
    return out


async def _hydrate(ms: list[dict]) -> list[dict]:
    if not ms:
        return ms
    files = await files_by_ids([f for m in ms for f in m["_files"]])
    by_id = {}
    for m in ms:
        m["attachments"] = [files[f] for f in m.pop("_files") if f in files]
        by_id[m["id"]] = m
    ids = list(by_id)
    reactions = await db.rows(
        f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({db.marks(len(ids))}) "
        "ORDER BY created_at",
        ids,
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
            f"SELECT id, author_id, text, deleted, attachments FROM messages WHERE id IN ({db.marks(len(reply_ids))})",
            reply_ids,
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
                "attachments": 0 if deleted else len(_split(r["attachments"])),
            }
        for m in ms:
            if m["reply_to"] is not None and m["reply_to"] in previews:
                m["reply"] = previews[m["reply_to"]]
    return ms


async def _collect(where: str, values: list) -> list[dict]:
    found = await db.rows(f"SELECT {_COLUMNS} FROM messages WHERE {where}", values)
    return await _hydrate([_message(m) for m in found])


async def messages_by_ids(ids: list[int]) -> list[dict]:
    if not ids:
        return []
    return await _collect(f"id IN ({db.marks(len(ids))})", list(ids))


async def message_by_id(mid: int) -> dict:
    found = await _collect("id = ?", [mid])
    if not found:
        raise NotFound
    return found[0]


async def create_message(cid: int, author: int, nonce: str, text: str, reply_to: int, attachments: list[str]):
    """A retried send with the same nonce returns the original message and created=False."""
    created = False
    try:
        async with in_transaction(CONN) as tx:
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
                    owners = dict(await File.filter(id__in=attachments).using_db(tx).values_list("id", "uploader_id"))
                    if any(owners.get(f) != author for f in attachments):
                        raise Forbidden
                m = await Message.create(
                    channel_id=cid, author_id=author, nonce=nonce, text=text, created_at=now(), reply_to=reply,
                    attachments=",".join(attachments), using_db=tx,
                )  # fmt: skip
                mid = m.id
                created = True
                await db.execute(
                    "UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND user_id = ?",
                    [mid, cid, author],
                    tx,
                )
    except IntegrityError:
        # A concurrent send with the same nonce won.
        existing = await Message.filter(author_id=author, nonce=nonce).first()
        if existing is None or existing.channel_id != cid:
            raise Conflict from None
        mid = existing.id
    return await message_by_id(mid), created


async def list_messages(cid: int, before: int, after: int, limit: int) -> list[dict]:
    if after > 0:
        return await _collect("channel_id = ? AND id > ? ORDER BY id LIMIT ?", [cid, after, limit])
    if before > 0:
        out = await _collect("channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?", [cid, before, limit])
    else:
        out = await _collect("channel_id = ? ORDER BY id DESC LIMIT ?", [cid, limit])
    out.reverse()
    return out


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


async def attachments_in(cids: list[int]) -> list[str]:
    found = await db.rows(
        f"SELECT attachments FROM messages WHERE channel_id IN ({db.marks(len(cids))}) AND attachments != ''", cids
    )
    return [f for r in found for f in _split(r["attachments"])]


async def pinned_messages(cid: int) -> list[dict]:
    return await _collect(
        "channel_id = ? AND deleted = 0 AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50", [cid]
    )


async def edit_message(mid: int, author: int, text: str) -> dict:
    n = await Message.filter(id=mid, author_id=author, deleted=0).update(text=text, edited_at=now())
    if n == 0:
        raise Forbidden
    return await message_by_id(mid)


async def delete_message(mid: int) -> dict:
    n = await Message.filter(id=mid, deleted=0).update(text="", attachments="", pinned_at=None, deleted=1)
    if n == 0:
        raise NotFound
    await db.execute("DELETE FROM reactions WHERE message_id = ?", [mid])
    return await message_by_id(mid)


async def toggle_reaction(mid: int, uid: int, emoji: str) -> dict:
    async with in_transaction(CONN) as tx:
        removed = await db.execute(
            "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", [mid, uid, emoji], tx
        )
        if not removed:
            distinct = await Reaction.filter(message_id=mid).using_db(tx).distinct().values_list("emoji", flat=True)
            if len(set(distinct)) >= 20:
                raise Conflict
            await Reaction.create(message_id=mid, user_id=uid, emoji=emoji, created_at=now(), using_db=tx)
    return await message_by_id(mid)


async def set_pinned(mid: int, pinned: bool) -> dict:
    await Message.filter(id=mid, deleted=0).update(pinned_at=now() if pinned else None)
    return await message_by_id(mid)


async def group_of_channel(cid: int) -> int:
    gid = await TextChannel.filter(channel_id=cid).values_list("group_id", flat=True)
    return gid[0] if gid else 0  # ty: ignore[invalid-return-type]
