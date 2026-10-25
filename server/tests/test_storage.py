import asyncio

import obstore
import pytest
from conftest import make_config
from obstore.store import MemoryStore
from test_features import TINY_PNG

from tolktak import storage
from tolktak.storage import S3Files, copy_files, parse_range

DATA = bytes(range(256)) * 4


@pytest.fixture
def s3_env(make_env):
    e = make_env()
    store = MemoryStore()
    e.server.files = S3Files(store)
    return e, store


def uploads_left(e) -> list:
    d = e.server.cfg.data_dir / "uploads"
    return list(d.iterdir()) if d.exists() else []


def test_s3_upload_download(s3_env):
    e, store = s3_env
    token, _ = e.user("alice")
    code, body = e.upload(token, "cat.png", TINY_PNG)
    assert code == 201, body
    fid = body["file"]["id"]
    assert obstore.get(store, fid).bytes().to_bytes() == TINY_PNG
    r = e.c.get(f"/api/v1/files/{fid}")
    assert r.status_code == 200 and r.content == TINY_PNG
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert r.headers["accept-ranges"] == "bytes"
    assert not uploads_left(e)


def test_s3_attachments_are_deleted_with_their_message(s3_env):
    e, store = s3_env
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    cid = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})[1]["channel"]["id"]
    fid = e.upload(a, "cat.png", TINY_PNG)[1]["file"]["id"]
    msg = {"text": "", "nonce": "n1", "attachments": [fid]}
    _, body = e.do("POST", f"/api/v1/channels/{cid}/messages", a, msg)
    assert e.do("DELETE", f"/api/v1/messages/{body['message']['id']}", a)[0] == 200
    with pytest.raises(FileNotFoundError):
        obstore.get(store, fid)


def test_s3_range(s3_env):
    e, _ = s3_env
    token, _ = e.user("alice")
    fid = e.upload(token, "a.mp3", DATA)[1]["file"]["id"]
    url = f"/api/v1/files/{fid}"

    r = e.c.get(url, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == DATA[10:20]
    assert r.headers["content-range"] == "bytes 10-19/1024"
    assert e.c.get(url, headers={"Range": "bytes=990-"}).content == DATA[990:]
    assert e.c.get(url, headers={"Range": "bytes=-5"}).content == DATA[-5:]
    r = e.c.get(url, headers={"Range": "bytes=2000-"})
    assert r.status_code == 416 and r.headers["content-range"] == "bytes */1024"
    r = e.c.get(url, headers={"Range": "nonsense"})
    assert r.status_code == 200 and r.content == DATA


def test_s3_missing_object(s3_env):
    e, store = s3_env
    token, _ = e.user("alice")
    fid = e.upload(token, "cat.png", TINY_PNG)[1]["file"]["id"]
    obstore.delete(store, fid)
    r = e.c.get(f"/api/v1/files/{fid}")
    assert r.status_code == 404 and r.text == "404 page not found\n"


def test_s3_too_large_leaves_nothing(s3_env):
    e, store = s3_env
    token, _ = e.user("alice")
    assert e.upload(token, "big.bin", bytes(2 << 20))[0] == 413
    assert obstore.list(store).collect() == []
    assert not uploads_left(e)


@pytest.mark.parametrize(
    "header, result",
    [
        ("", None),
        ("bytes=0-0", (0, 0)),
        ("bytes=10-19", (10, 19)),
        ("bytes=10-5000", (10, 1023)),
        ("bytes=990-", (990, 1023)),
        ("bytes=-5", (1019, 1023)),
        ("bytes=-5000", (0, 1023)),
        ("bytes=1024-", "invalid"),
        ("bytes=-0", "invalid"),
        ("bytes=5-1", None),
        ("bytes=0-1,5-9", None),
        ("items=0-1", None),
        ("nonsense", None),
    ],
)
def test_parse_range(header, result):
    assert parse_range(header, 1024) == result


def test_copy_files(tmp_path, monkeypatch):
    cfg = make_config(tmp_path, s3_bucket="files", s3_access_key="k", s3_secret_key="s")
    cfg.files_dir.mkdir(parents=True)
    (cfg.files_dir / ("a" * 32)).write_bytes(b"one")
    (cfg.files_dir / ("b" * 32)).write_bytes(b"two")
    store = MemoryStore()
    monkeypatch.setattr(storage, "s3_store", lambda _: store)
    assert asyncio.run(copy_files(cfg)) == 0
    assert asyncio.run(copy_files(cfg)) == 0
    assert sorted(m["path"] for m in obstore.list(store).collect()) == ["a" * 32, "b" * 32]
    assert obstore.get(store, "b" * 32).bytes().to_bytes() == b"two"


def test_copy_files_needs_bucket(tmp_path):
    assert asyncio.run(copy_files(make_config(tmp_path))) == 2


def test_s3_head_reads_no_body(s3_env, monkeypatch):
    e, store = s3_env
    token, _ = e.user("alice")
    fid = e.upload(token, "a.mp3", DATA)[1]["file"]["id"]

    async def no_download(*args, **kwargs):
        raise AssertionError("HEAD downloaded the object")

    monkeypatch.setattr(storage.obstore, "get_async", no_download)
    r = e.c.head(f"/api/v1/files/{fid}")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["content-length"] == "1024"
    obstore.delete(store, fid)
    assert e.c.head(f"/api/v1/files/{fid}").status_code == 404
