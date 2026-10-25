"""Reads are not authenticated: <img> and <audio> cannot send the token, the random id is the access."""

import asyncio
import contextlib
import logging
import mimetypes
import os
import posixpath
import re
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse

from ..errors import ApiError, NotFound
from ..server import Server, current_user
from ..sniff import SNIFF_LEN, detect_content_type, image_size
from ..store import files, now
from .common import json_response, query_int, server

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("tolktak")

User = Annotated[dict, Depends(current_user)]

MAX_SIDE = 16384

# The built-in table only, the same on every host: mimetypes.guess_type also reads files such as /etc/mime.types.
_MIME_TYPES = mimetypes.MimeTypes()

# Control and text direction characters: an override shows "a\u202egpj.exe" as "aexe.jpg".
_HIDDEN = re.compile("[\x00-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def clean_name(raw: str) -> str:
    raw = _HIDDEN.sub("", raw)
    name = raw.replace("\\", "/").rstrip("/")
    name = posixpath.basename(name) if name else ("/" if raw.replace("\\", "/") else ".")
    name = name.strip()
    if name in ("", ".", "/"):
        name = "file"
    return name[-120:]


@router.post("/files")
async def upload(request: Request, user: User):
    s = server(request)
    me = user["id"]
    s.limit(f"upload:{me}", 20, 60, "Too many uploads, slow down")
    # One upload at a time per user, so parallel uploads cannot pass the quota together.
    async with s.upload_locks.setdefault(me, asyncio.Lock()):
        return await receive_file(request, s, me)


async def receive_file(request: Request, s: Server, me: int):
    limit = s.cfg.max_upload_bytes
    too_large = ApiError(413, "too_large", f"File exceeds {limit >> 20} MB")
    quota = s.cfg.user_quota_bytes
    room = quota - await files.used_bytes(me) if quota else float("inf")
    full = ApiError(507, "quota_exceeded", "Your file storage on this server is full")
    with contextlib.suppress(ValueError):
        declared = int(request.headers.get("content-length", "0"))
        if declared > limit:
            raise too_large
        if declared > room:
            raise full
    name = clean_name(request.query_params.get("name", ""))
    uploads = s.cfg.data_dir / "uploads"
    os.makedirs(uploads, mode=0o750, exist_ok=True)
    fid = files.new_file_id()
    path = uploads / fid
    head = b""
    size = 0
    ok = False
    try:
        with open(path, "xb") as f:
            os.chmod(path, 0o640)
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > limit:
                    raise too_large
                if size > room:
                    raise full
                if len(head) < SNIFF_LEN:
                    head += chunk[: SNIFF_LEN - len(head)]
                f.write(chunk)
        if size == 0:
            raise ApiError(400, "empty_file", "File is empty")
        # The content is trusted over the client.
        ctype = detect_content_type(head)
        by_name = _MIME_TYPES.guess_file_type(name)[0]
        if by_name and (ctype == "application/octet-stream" or ctype.startswith("text/plain")):
            ctype = by_name
        ctype = ctype.split(";")[0].strip()
        # Sniffing and mimetypes give WAV and Ogg other names; players and INLINE_TYPES expect these.
        ctype = {
            "audio/wave": "audio/wav",
            "audio/vnd.wave": "audio/wav",
            "application/ogg": "audio/ogg",
        }.get(ctype, ctype)
        # WebM sniffs as video, but a client voice message is audio-only WebM.
        if ctype == "video/webm" and request.headers.get("content-type", "").startswith("audio/webm"):
            ctype = "audio/webm"
        # So does MP4, but an M4A file is audio.
        if ctype == "video/mp4" and by_name == "audio/mp4":
            ctype = by_name
        meta = {"id": fid, "name": name, "mime": ctype, "size": size}
        if ctype.startswith("image/"):
            w, h = image_size(str(path), ctype)
            if w == 0:
                # Formats not parsed here (webp, avif): accept the client's measurement.
                w, h = query_int(request, "w"), query_int(request, "h")
                if not (0 < w <= MAX_SIDE and 0 < h <= MAX_SIDE):
                    w = h = 0
            if w:
                meta["width"] = w
            if h:
                meta["height"] = h
        await s.files.save(fid, path)
        await files.create_file(me, meta)
        ok = True
    finally:
        if not ok:
            with contextlib.suppress(OSError):
                os.remove(path)
    return json_response({"file": files.file_dict(meta)}, 201)


# Uploads that were never sent and replaced pictures count against the quota until removed.
async def remove_old_unused_files(s: Server) -> None:
    fids = await files.unused_before(now() - 24 * 60 * 60 * 1000)
    for i in range(0, len(fids), 500):
        await remove_unused_files(s, fids[i : i + 500])


async def remove_unused_files(s: Server, fids: list[str]) -> None:
    for fid in await files.delete_unused(fids):
        try:
            await s.files.delete(fid)
        except Exception as e:
            log.warning("delete file id=%s: %r", fid, e)


# Rendered by the client; everything else is downloaded.
INLINE_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4", "audio/x-wav", "audio/aac", "audio/flac",
    "video/mp4", "video/webm",
}  # fmt: skip


@router.get("/files/{id}")
@router.get("/files/{id}/{name}")
async def download(request: Request, id: str):
    not_found = PlainTextResponse("404 page not found\n", status_code=404)
    if not files.valid_file_id(id):
        return not_found
    try:
        meta, _ = await files.file_by_id(id)
    except NotFound:
        return not_found
    ctype = meta["mime"]
    disp = "inline" if ctype in INLINE_TYPES else "attachment"
    if disp == "attachment":
        ctype = "application/octet-stream"
    headers = {
        "Content-Disposition": f"{disp}; filename*=UTF-8''{quote(meta['name'], safe='')}",
        "Cache-Control": "private, max-age=31536000, immutable",
        # Uploaded content never runs as a page of this origin.
        "Content-Security-Policy": "sandbox; default-src 'none'",
    }
    return await server(request).files.response(id, request, meta["size"], ctype, headers) or not_found
