import logging
import os
import re
from pathlib import Path
from typing import Literal

import obstore
from fastapi import Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from obstore.store import S3Store

from .config import Config

log = logging.getLogger("tolktak")

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def parse_range(header: str, size: int) -> tuple[int, int] | Literal["invalid"] | None:
    # Inclusive bounds of a single range; None serves the whole file, as for a header we do not understand.
    m = _RANGE.fullmatch(header.strip())
    if not m or not (m[1] or m[2]):
        return None
    if not m[1]:
        n = int(m[2])
        return (max(size - n, 0), size - 1) if n else "invalid"
    first = int(m[1])
    last = int(m[2]) if m[2] else size - 1
    if first >= size:
        return "invalid"
    if last < first:
        return None
    return first, min(last, size - 1)


class DiskFiles:
    def __init__(self, root: Path):
        self.root = root

    async def save(self, fid: str, tmp: Path) -> None:
        os.makedirs(self.root, mode=0o750, exist_ok=True)
        os.replace(tmp, self.root / fid)

    async def delete(self, fid: str) -> None:
        (self.root / fid).unlink(missing_ok=True)

    async def response(
        self, fid: str, request: Request, size: int, media_type: str, headers: dict[str, str]
    ) -> Response | None:
        path = self.root / fid
        if not path.is_file():
            return None
        return FileResponse(path, media_type=media_type, headers=headers)


class S3Files:
    def __init__(self, store):
        self.store = store

    async def save(self, fid: str, tmp: Path) -> None:
        await obstore.put_async(self.store, fid, tmp)
        tmp.unlink()

    async def delete(self, fid: str) -> None:
        await obstore.delete_async(self.store, fid)

    async def response(
        self, fid: str, request: Request, size: int, media_type: str, headers: dict[str, str]
    ) -> Response | None:
        headers = {**headers, "Accept-Ranges": "bytes", "Content-Length": str(size)}
        if request.scope.get("head"):
            try:
                await obstore.head_async(self.store, fid)
            except FileNotFoundError:
                return None
            return Response(media_type=media_type, headers=headers)
        rng = parse_range(request.headers.get("range", ""), size)
        if rng == "invalid":
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        try:
            if rng is None:
                result = await obstore.get_async(self.store, fid)
            else:
                result = await obstore.get_async(self.store, fid, options={"range": (rng[0], rng[1] + 1)})
        except FileNotFoundError:
            return None
        status = 200
        if rng is not None:
            status = 206
            headers["Content-Range"] = f"bytes {rng[0]}-{rng[1]}/{size}"
            headers["Content-Length"] = str(rng[1] - rng[0] + 1)

        async def body():
            async for chunk in result.stream():
                yield memoryview(chunk)

        return StreamingResponse(body(), status_code=status, media_type=media_type, headers=headers)


def s3_store(cfg: Config) -> S3Store:
    config = {
        "region": cfg.s3_region or "us-east-1",
        "access_key_id": cfg.s3_access_key,
        "secret_access_key": cfg.s3_secret_key,
    }
    if cfg.s3_endpoint:
        config["endpoint"] = cfg.s3_endpoint
    return S3Store(cfg.s3_bucket, config=config, client_options={"allow_http": cfg.s3_endpoint.startswith("http://")})


def open_storage(cfg: Config) -> DiskFiles | S3Files:
    return S3Files(s3_store(cfg)) if cfg.s3_bucket else DiskFiles(cfg.files_dir)


async def copy_files(cfg: Config) -> int:
    if not cfg.s3_bucket:
        log.error("TOLKTAK_S3_BUCKET is not set")
        return 2
    store = s3_store(cfg)
    copied = skipped = 0
    for path in sorted(cfg.files_dir.iterdir()) if cfg.files_dir.is_dir() else []:
        try:
            await obstore.head_async(store, path.name)
            skipped += 1
        except FileNotFoundError:
            await obstore.put_async(store, path.name, path)
            copied += 1
    log.info("copied files=%d skipped=%d", copied, skipped)
    return 0
