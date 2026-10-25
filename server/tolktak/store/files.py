import secrets

from .. import db
from ..errors import NotFound
from ..models import File
from . import now

# A file is identified by a random 128-bit id: knowing it is what grants read access (see api/files.py).


def new_file_id() -> str:
    return secrets.token_hex(16)


def valid_file_id(fid: str) -> bool:
    if len(fid) != 32:
        return False
    try:
        bytes.fromhex(fid)
    except ValueError:
        return False
    return True


def file_dict(f: File | dict) -> dict:
    g = f.get if isinstance(f, dict) else lambda k: getattr(f, k)
    out = {"id": g("id"), "name": g("name"), "mime": g("mime"), "size": g("size")}
    if g("width"):
        out["width"] = g("width")
    if g("height"):
        out["height"] = g("height")
    return out


async def create_file(uploader: int, meta: dict) -> None:
    await File.create(
        id=meta["id"], uploader_id=uploader, name=meta["name"], mime=meta["mime"], size=meta["size"],
        width=meta.get("width", 0), height=meta.get("height", 0), created_at=now(),
    )  # fmt: skip


async def used_bytes(uid: int) -> int:
    found = await db.rows("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE uploader_id = ?", [uid])
    return int(found[0]["n"])


async def file_by_id(fid: str) -> tuple[dict, int]:
    f = await File.filter(id=fid).first()
    if f is None:
        raise NotFound
    return file_dict(f), f.uploader_id


_UNUSED = (
    "NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = files.id) "
    "AND id NOT IN (SELECT avatar FROM users UNION SELECT avatar FROM groups)"
)


async def delete_unused(fids: list[str]) -> list[str]:
    """Deletes the records of files no message, profile or group uses and returns their ids."""
    if not fids:
        return []
    fids = list(set(fids))
    found = await db.rows(f"DELETE FROM files WHERE id IN ({db.marks(len(fids))}) AND {_UNUSED} RETURNING id", fids)
    return [r["id"] for r in found]


async def unused_before(t: int) -> list[str]:
    """Ids of files uploaded before t that no message, profile or group uses."""
    return [r["id"] for r in await db.rows(f"SELECT id FROM files WHERE created_at < ? AND {_UNUSED}", [t])]
