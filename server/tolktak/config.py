import os
from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    server_name: str = "TolkTak"
    # "open", "invite" or "closed". The first account can always be created.
    registration: str = "invite"
    # ws(s):// URL clients use to reach the SFU.
    livekit_public_url: str = ""
    livekit_internal_url: str = "http://127.0.0.1:7880"
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    client_download_url: str = ""
    # Use X-Forwarded-For for rate limiting (enable only behind a reverse proxy).
    trust_proxy: bool = False
    data_dir: Path = Path("data")
    # SQLite in the data directory unless a postgres:// URL is given.
    database_url: str = ""
    max_upload_bytes: int = 50 << 20
    # Total size of the files one user may keep; 0 for no limit.
    user_quota_bytes: int = 2048 << 20
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    debug: bool = False

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or default


def parse_listen(addr: str) -> tuple[str, int]:
    host, sep, port = addr.rpartition(":")
    if not sep or not port.isdigit():
        raise ConfigError(f"TOLKTAK_LISTEN must be host:port or :port, got {addr!r}")
    host = host.strip("[]") or "0.0.0.0"
    return host, int(port)


def from_env() -> Config:
    key, secret = _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")
    if not key or len(secret) < 32:
        raise ConfigError("LIVEKIT_API_KEY and LIVEKIT_API_SECRET (>= 32 chars) are required")
    reg = _env("TOLKTAK_REGISTRATION", "invite")
    if reg not in ("open", "invite", "closed"):
        raise ConfigError(f"TOLKTAK_REGISTRATION must be open, invite or closed, got {reg!r}")
    public_lk = _env("LIVEKIT_PUBLIC_URL")
    if not public_lk:
        raise ConfigError("LIVEKIT_PUBLIC_URL is required (ws:// or wss:// URL clients use to reach LiveKit)")
    try:
        max_mb = int(_env("TOLKTAK_MAX_UPLOAD_MB", "50"))
    except ValueError:
        max_mb = 0
    if max_mb < 1:
        raise ConfigError("TOLKTAK_MAX_UPLOAD_MB must be a positive number")
    try:
        quota_mb = int(_env("TOLKTAK_USER_QUOTA_MB", "2048"))
    except ValueError:
        quota_mb = -1
    if quota_mb < 0:
        raise ConfigError("TOLKTAK_USER_QUOTA_MB must be a number of megabytes, 0 for no limit")
    db = _env("TOLKTAK_DATABASE_URL")
    if db and not db.startswith(("sqlite://", "postgres://", "postgresql://")):
        raise ConfigError("TOLKTAK_DATABASE_URL must start with postgres://, postgresql:// or sqlite://")
    host, port = parse_listen(_env("TOLKTAK_LISTEN", ":8080"))
    return Config(
        server_name=_env("TOLKTAK_SERVER_NAME", "TolkTak"),
        registration=reg,
        livekit_public_url=public_lk,
        livekit_internal_url=_env("LIVEKIT_INTERNAL_URL", "http://127.0.0.1:7880").rstrip("/"),
        livekit_api_key=key,
        livekit_api_secret=secret,
        client_download_url=_env("TOLKTAK_CLIENT_DOWNLOAD_URL"),
        trust_proxy=_env("TOLKTAK_TRUST_PROXY") == "1",
        data_dir=Path(_env("TOLKTAK_DATA_DIR", "./data")),
        database_url=db,
        max_upload_bytes=max_mb << 20,
        user_quota_bytes=quota_mb << 20,
        listen_host=host,
        listen_port=port,
        debug=_env("TOLKTAK_DEBUG") == "1",
    )
