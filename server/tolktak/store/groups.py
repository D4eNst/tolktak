from typing import Any

from tortoise.transactions import in_transaction

from .. import db
from ..db import CONN
from ..errors import Conflict, Forbidden, NotFound
from ..models import Channel, ChannelMember, Group, GroupMember, Room, TextChannel, User
from . import files, now


async def lock_group(gid: int, tx: db.BaseDBAsyncClient) -> None:
    # Always group before channel: revocation and message writes share this order.
    found = await db.rows("UPDATE groups SET owner_id = owner_id WHERE id = ? RETURNING id", [gid], tx)
    if not found:
        raise NotFound


async def _require_moderator(gid: int, uid: int, tx: db.BaseDBAsyncClient) -> None:
    found = await db.rows(
        "SELECT g.owner_id, m.role FROM groups g JOIN group_members m ON m.group_id = g.id "
        "WHERE g.id = ? AND m.user_id = ?",
        [gid, uid],
        tx,
    )
    if not found:
        raise NotFound
    if found[0]["owner_id"] != uid and found[0]["role"] != "mod":
        raise Forbidden


async def _require_owner(gid: int, uid: int, tx: db.BaseDBAsyncClient) -> None:
    await _require_moderator(gid, uid, tx)
    if not await Group.filter(id=gid, owner_id=uid).using_db(tx).exists():
        raise Forbidden


async def set_order(gid: int, uid: int, ids: list[int], resource: str) -> bool:
    if resource == "channels":
        table, key = "text_channels", "channel_id"
    elif resource == "rooms":
        table, key = "rooms", "id"
    else:
        raise ValueError("Unknown group resource")
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_moderator(gid, uid, tx)
        current = [
            r["id"]
            for r in await db.rows(
                f"SELECT {key} AS id FROM {table} WHERE group_id = ? ORDER BY position, {key}", [gid], tx
            )
        ]
        if len(set(ids)) != len(ids) or set(ids) != set(current):
            raise Conflict
        if ids == current:
            return False
        await tx.execute_many(
            db.sql(f"UPDATE {table} SET position = ? WHERE group_id = ? AND {key} = ?", tx),
            [[position, gid, item] for position, item in enumerate(ids)],
        )
        return True


def room_dict(r: Room | dict) -> dict:
    if isinstance(r, dict):
        return {"id": r["id"], "group_id": r["group_id"], "name": r["name"], "position": r["position"]}
    return {"id": r.id, "group_id": r.group_id, "name": r.name, "position": r.position}


def role(g: dict, uid: int) -> str:
    if uid == g["owner_id"]:
        return "owner"
    if (r := g["roles"].get(str(uid))) is not None:
        return r
    return "member" if uid in g["members"] else ""


def can_moderate(g: dict, uid: int) -> bool:
    return role(g, uid) in ("owner", "mod")


async def create_group(name: str, owner: int, members: list[int], room_name: str, channel_name: str) -> dict:
    async with in_transaction(CONN) as tx:
        if len({owner, *members}) > 200:
            raise Conflict
        t = now()
        ch = await Channel.create(kind="group", created_at=t, using_db=tx)
        g = await Group.create(name=name, owner_id=owner, channel_id=ch.id, created_at=t, using_db=tx)
        await Room.create(group_id=g.id, name=room_name, position=0, created_at=t, using_db=tx)
        await TextChannel.create(channel_id=ch.id, group_id=g.id, name=channel_name, position=0, created_at=t,
                                 using_db=tx)  # fmt: skip
        await _add_members(tx, g.id, [owner, *members])
    return await group_by_id(g.id)


async def _add_members(tx, gid: int, users: list[int]) -> None:
    t = now()
    for u in users:
        if not await User.filter(id=u).using_db(tx).exists():
            raise NotFound
        if db.is_postgres(tx):
            ignore, conflict = "", " ON CONFLICT DO NOTHING"
        else:
            ignore, conflict = " OR IGNORE", ""
        await db.execute(
            f"INSERT{ignore} INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?){conflict}",
            [gid, u, t],
            tx,
        )
        # New members start caught up on the group history.
        await db.execute(
            f"""INSERT{ignore} INTO channel_members (channel_id, user_id, last_read_id)
            SELECT t.channel_id, ?, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = t.channel_id), 0)
            FROM text_channels t WHERE t.group_id = ?{conflict}""",
            [u, gid],
            tx,
        )


async def group_by_id(gid: int) -> dict:
    found = await groups_by_ids([gid])
    if not found:
        raise NotFound
    return found[0]


async def groups_by_ids(gids: list[int]) -> list[dict]:
    if not gids:
        return []
    m = db.marks(len(gids))
    groups = await db.rows(
        f"SELECT id, name, owner_id, channel_id, avatar, description, created_at FROM groups WHERE id IN ({m})", gids
    )
    members = await db.rows(
        f"SELECT group_id, user_id, role FROM group_members WHERE group_id IN ({m}) ORDER BY joined_at", gids
    )
    rooms = await db.rows(
        f"SELECT id, group_id, name, position FROM rooms WHERE group_id IN ({m}) ORDER BY position, id", gids
    )
    channels = await db.rows(
        f"SELECT channel_id, group_id, name, position FROM text_channels WHERE group_id IN ({m}) "
        "ORDER BY position, channel_id",
        gids,
    )
    out: dict[int, dict[str, Any]] = {}
    for g in groups:
        out[g["id"]] = {
            "id": g["id"],
            "name": g["name"],
            "owner_id": g["owner_id"],
            "channel_id": g["channel_id"],  # main text channel
            "avatar": g["avatar"],
            "description": g["description"],
            "members": [],
            "roles": {},
            "rooms": [],
            "text_channels": [],
            "created_at": g["created_at"],
        }
    for r in members:
        if (g := out.get(r["group_id"])) is not None:
            g["members"].append(r["user_id"])
            if r["role"] != "member":
                g["roles"][str(r["user_id"])] = r["role"]
    for r in rooms:
        if (g := out.get(r["group_id"])) is not None:
            g["rooms"].append(room_dict(r))
    for c in channels:
        if (g := out.get(c["group_id"])) is not None:
            g["text_channels"].append({"id": c["channel_id"], "name": c["name"], "position": c["position"]})
    return [out[gid] for gid in gids if gid in out]


async def update_group(gid: int, actor: int, **fields: str) -> None:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_moderator(gid, actor, tx)
        if fields.get("avatar"):
            await files.require_avatar(fields["avatar"], actor, tx)
        if fields:
            await Group.filter(id=gid).using_db(tx).update(**fields)


async def set_group_role(gid: int, uid: int, r: str, actor: int) -> None:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_owner(gid, actor, tx)
        if await Group.filter(id=gid, owner_id=uid).using_db(tx).exists():
            raise Forbidden
        n = await db.execute("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?", [r, gid, uid], tx)
        if n == 0:
            raise NotFound


async def create_text_channel(gid: int, name: str, uid: int) -> tuple[int, int]:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_moderator(gid, uid, tx)
        t = now()
        ch = await Channel.create(kind="group", created_at=t, using_db=tx)
        positions = await TextChannel.filter(group_id=gid).using_db(tx).values_list("position", flat=True)
        if len(positions) >= 30:
            raise Conflict
        position = max(positions, default=-1) + 1  # ty: ignore[unsupported-operator]
        await TextChannel.create(
            channel_id=ch.id, group_id=gid, name=name, position=position, created_at=t, using_db=tx
        )
        members = await GroupMember.filter(group_id=gid).using_db(tx).values_list("user_id", flat=True)
        await ChannelMember.bulk_create([ChannelMember(channel_id=ch.id, user_id=u) for u in members], using_db=tx)
    return ch.id, position


async def rename_text_channel(cid: int, name: str, actor: int) -> None:
    async with in_transaction(CONN) as tx:
        channel = await TextChannel.filter(channel_id=cid).using_db(tx).first()
        if channel is None:
            raise NotFound
        await lock_group(channel.group_id, tx)
        await _require_moderator(channel.group_id, actor, tx)
        if not await db.execute("UPDATE text_channels SET name = ? WHERE channel_id = ?", [name, cid], tx):
            raise NotFound


async def delete_text_channel(cid: int, uid: int) -> None:
    async with in_transaction(CONN) as tx:
        group = await TextChannel.filter(channel_id=cid).using_db(tx).first()
        if group is None:
            raise NotFound
        await lock_group(group.group_id, tx)
        await _require_moderator(group.group_id, uid, tx)
        if not await TextChannel.filter(channel_id=cid).using_db(tx).exists():
            raise NotFound
        await Channel.filter(id=cid).using_db(tx).delete()


async def groups_for_user(uid: int) -> list[dict]:
    found = await db.rows("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY joined_at", [uid])
    return await groups_by_ids([r["group_id"] for r in found])


async def is_group_member(gid: int, uid: int) -> bool:
    return await GroupMember.filter(group_id=gid, user_id=uid).exists()


async def _delete_group(g: Group, tx: db.BaseDBAsyncClient) -> list[str]:
    files = await db.rows(
        "SELECT mf.file_id FROM message_files mf JOIN messages m ON m.id = mf.message_id "
        "JOIN text_channels t ON t.channel_id = m.channel_id WHERE t.group_id = ?",
        [g.id],
        tx,
    )
    others = (
        await TextChannel.filter(group_id=g.id, channel_id__not=g.channel_id)
        .using_db(tx)
        .values_list("channel_id", flat=True)
    )
    if others:
        await Channel.filter(id__in=others).using_db(tx).delete()
    await Group.filter(id=g.id).using_db(tx).delete()
    await Channel.filter(id=g.channel_id).using_db(tx).delete()
    return [file["file_id"] for file in files]


async def delete_group(gid: int, actor: int) -> tuple[list[str], list[int]]:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_owner(gid, actor, tx)
        g = await Group.filter(id=gid).using_db(tx).first()
        if g is None:
            raise NotFound
        members = await GroupMember.filter(group_id=gid).using_db(tx).values_list("user_id", flat=True)
        return await _delete_group(g, tx), list(members)  # ty: ignore[invalid-return-type]


async def add_group_members(gid: int, users: list[int], actor: int) -> None:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_moderator(gid, actor, tx)
        members = await GroupMember.filter(group_id=gid).using_db(tx).values_list("user_id", flat=True)
        if len(set(members) | set(users)) > 200:
            raise Conflict
        await _add_members(tx, gid, users)


async def remove_group_member(gid: int, uid: int, actor: int) -> tuple[bool, list[str]]:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        g = await Group.filter(id=gid).using_db(tx).first()
        if g is None:
            raise NotFound
        target = await GroupMember.filter(group_id=gid, user_id=uid).using_db(tx).first()
        if target is None:
            raise NotFound
        if actor != uid:
            await _require_moderator(gid, actor, tx)
            if uid == g.owner_id or (target.role == "mod" and actor != g.owner_id):
                raise Forbidden
        await db.execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [gid, uid], tx)
        await db.execute(
            "DELETE FROM channel_members WHERE user_id = ? AND (channel_id = ? OR channel_id IN "
            "(SELECT channel_id FROM text_channels WHERE group_id = ?))",
            [uid, g.channel_id, gid],
            tx,
        )
        if not await GroupMember.filter(group_id=gid).using_db(tx).exists():
            return True, await _delete_group(g, tx)
        if uid == g.owner_id:
            await _transfer_ownership(gid, tx)
        return False, []


async def _transfer_ownership(gid: int, tx: db.BaseDBAsyncClient) -> None:
    nxt = (
        await GroupMember.filter(group_id=gid)
        .using_db(tx)
        .order_by("joined_at", "user_id")
        .limit(1)
        .values_list("user_id", flat=True)
    )
    await Group.filter(id=gid).using_db(tx).update(owner_id=nxt[0])
    await db.execute("UPDATE group_members SET role = 'member' WHERE group_id = ? AND user_id = ?", [gid, nxt[0]], tx)


async def create_room(gid: int, name: str, uid: int) -> dict:
    async with in_transaction(CONN) as tx:
        await lock_group(gid, tx)
        await _require_moderator(gid, uid, tx)
        positions = await Room.filter(group_id=gid).using_db(tx).values_list("position", flat=True)
        if len(positions) >= 20:
            raise Conflict
        position = max(positions, default=-1) + 1  # ty: ignore[unsupported-operator]
        r = await Room.create(group_id=gid, name=name, position=position, created_at=now(), using_db=tx)
        return room_dict(r)


async def room_by_id(rid: int) -> dict:
    r = await Room.filter(id=rid).first()
    if r is None:
        raise NotFound
    return room_dict(r)


async def rename_room(rid: int, name: str, actor: int) -> None:
    async with in_transaction(CONN) as tx:
        room = await Room.filter(id=rid).using_db(tx).first()
        if room is None:
            raise NotFound
        await lock_group(room.group_id, tx)
        await _require_moderator(room.group_id, actor, tx)
        if not await Room.filter(id=rid).using_db(tx).update(name=name):
            raise NotFound


async def delete_room(rid: int, uid: int) -> None:
    async with in_transaction(CONN) as tx:
        room = await Room.filter(id=rid).using_db(tx).first()
        if room is None:
            raise NotFound
        await lock_group(room.group_id, tx)
        await _require_moderator(room.group_id, uid, tx)
        if not await Room.filter(id=rid).using_db(tx).exists():
            raise NotFound
        if await Room.filter(group_id=room.group_id).using_db(tx).count() <= 1:
            raise Conflict
        await Room.filter(id=rid).using_db(tx).delete()
