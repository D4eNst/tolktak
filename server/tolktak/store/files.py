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


async def file_by_id(fid: str) -> tuple[dict, int]:
    f = await File.filter(id=fid).first()
    if f is None:
        raise NotFound
    return file_dict(f), f.uploader_id


async def files_by_ids(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    ids = list(set(ids))
    found = await db.rows(
        f"SELECT id, name, mime, size, width, height FROM files WHERE id IN ({db.marks(len(ids))})", ids
    )
    return {f["id"]: file_dict(f) for f in found}
