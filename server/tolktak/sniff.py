import struct

SNIFF_LEN = 512

_WS = b"\t\n\x0c\r "
_HTML_TAGS = [
    b"<!DOCTYPE HTML", b"<HTML", b"<HEAD", b"<SCRIPT", b"<IFRAME", b"<H1", b"<DIV", b"<FONT", b"<TABLE",
    b"<A", b"<STYLE", b"<TITLE", b"<B", b"<BODY", b"<BR", b"<P", b"<!--",
]  # fmt: skip

# (mask, pattern, type); data & mask must equal pattern.
_MASKED = [
    (b"\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", b"FORM\x00\x00\x00\x00AIFF", "audio/aiff"),
    (b"\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff\xff\xff", b"RIFF\x00\x00\x00\x00WEBPVP", "image/webp"),
    (b"\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", b"RIFF\x00\x00\x00\x00AVI ", "video/avi"),
    (b"\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", b"RIFF\x00\x00\x00\x00WAVE", "audio/wave"),
    (
        b"\xff\xff\x00\x00\x00\x00\x00\x00\x00\x00\xff\xff",
        b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00LP",
        "application/vnd.ms-fontobject",
    ),  # noqa: E501
]

_EXACT = [
    (b"%PDF-", "application/pdf"),
    (b"%!PS-Adobe-", "application/postscript"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
    (b"\x00\x00\x02\x00", "image/x-icon"),
    (b"BM", "image/bmp"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"ID3", "audio/mpeg"),
    (b"OggS\x00", "application/ogg"),
    (b"MThd\x00\x00\x00\x06", "audio/midi"),
    (b"\x1a\x45\xdf\xa3", "video/webm"),
    (b"\x00\x01\x00\x00", "font/ttf"),
    (b"OTTO", "font/otf"),
    (b"ttcf", "font/collection"),
    (b"wOFF", "font/woff"),
    (b"wOF2", "font/woff2"),
    (b"\x1f\x8b\x08", "application/x-gzip"),
    (b"PK\x03\x04", "application/zip"),
    (b"Rar!\x1a\x07\x00", "application/x-rar-compressed"),
    (b"Rar!\x1a\x07\x01\x00", "application/x-rar-compressed"),
    (b"\x00asm", "application/wasm"),
]

_BINARY = frozenset([*range(0x00, 0x09), 0x0B, *range(0x0E, 0x1B), *range(0x1C, 0x20)])


def _is_mp4(data: bytes) -> bool:
    if len(data) < 12:
        return False
    box = struct.unpack(">I", data[:4])[0]
    if len(data) < box or box % 4 != 0 or data[4:8] != b"ftyp":
        return False
    for st in range(8, box, 4):
        if st == 12:
            continue  # minor version number
        if data[st : st + 3] == b"mp4":
            return True
    return False


def detect_content_type(data: bytes) -> str:
    data = data[:SNIFF_LEN]
    i = 0
    while i < len(data) and data[i] in _WS:
        i += 1
    rest = data[i:]
    for tag in _HTML_TAGS:
        if len(rest) > len(tag) and rest[: len(tag)].upper() == tag and rest[len(tag)] in b" >":
            return "text/html; charset=utf-8"
    if rest.startswith(b"<?xml"):
        return "text/xml; charset=utf-8"
    for sig, ctype in _EXACT[:2]:
        if data.startswith(sig):
            return ctype
    if data.startswith(b"\xfe\xff"):
        return "text/plain; charset=utf-16be"
    if data.startswith(b"\xff\xfe"):
        return "text/plain; charset=utf-16le"
    if data.startswith(b"\xef\xbb\xbf"):
        return "text/plain; charset=utf-8"
    for sig, ctype in _EXACT[2:]:
        if data.startswith(sig):
            return ctype
    for mask, pat, ctype in _MASKED:
        if len(data) >= len(pat) and all(d & m == p for d, m, p in zip(data, mask, pat, strict=False)):
            return ctype
    if _is_mp4(data):
        return "video/mp4"
    if any(b in _BINARY for b in data):
        return "application/octet-stream"
    return "text/plain; charset=utf-8"


# Go's built-in extension table, used when sniffing finds nothing specific.
_BY_EXT = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".mjs": "text/javascript; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".xml": "text/xml; charset=utf-8",
}


def type_by_extension(ext: str) -> str:
    return _BY_EXT.get(ext.lower(), "")


def image_size(path: str, ctype: str) -> tuple[int, int]:
    try:
        with open(path, "rb") as f:
            if ctype == "image/png":
                head = f.read(24)
                if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                    return struct.unpack(">II", head[16:24])
            elif ctype == "image/gif":
                head = f.read(10)
                if head[:3] == b"GIF":
                    return struct.unpack("<HH", head[6:10])
            elif ctype == "image/jpeg":
                return _jpeg_size(f)
    except OSError, struct.error:
        pass
    return 0, 0


def _jpeg_size(f) -> tuple[int, int]:
    if f.read(2) != b"\xff\xd8":
        return 0, 0
    while True:
        b = f.read(1)
        while b and b != b"\xff":
            b = f.read(1)
        while b == b"\xff":
            b = f.read(1)
        if not b:
            return 0, 0
        marker = b[0]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        seg = f.read(2)
        if len(seg) < 2:
            return 0, 0
        length = struct.unpack(">H", seg)[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            sof = f.read(5)
            if len(sof) < 5:
                return 0, 0
            h, w = struct.unpack(">HH", sof[1:5])
            return w, h
        f.seek(length - 2, 1)
