import os
from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    server_name: str = "TolkTak"
    # open/invite/closed; the first account is always allowed.
    registration: str = "invite"
    livekit_public_url: str = ""  # legacy: no longer advertised to clients
    # Public app signaling origin; empty derives it from the request.
    signaling_public_url: str = ""
    signaling_private: bool = False
    livekit_internal_url: str = "http://127.0.0.1:7880"
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    # Start LiveKit with persistent keys in the data directory.
    embedded_livekit: bool = False
    client_download_url: str = ""
    # Trust forwarded headers only behind a reverse proxy.
    trust_proxy: bool = False
    data_dir: Path = Path("data")
    # Empty uses SQLite in the data directory.
    database_url: str = ""
    # A bucket switches file storage from disk to S3.
    s3_bucket: str = ""
    s3_endpoint: str = ""
    s3_region: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    max_upload_bytes: int = 50 << 20
    # Per-user quota; 0 disables it.
    user_quota_bytes: int = 2048 << 20
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    debug: bool = False
    # "auto", "manual" or "off".
    updates: str = "manual"
    # GitHub release source; set by the release image.
    repository: str = "D4eNst/tolktak"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def updates_dir(self) -> Path:
        return self.data_dir / "updates"


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or default


def parse_listen(addr: str) -> tuple[str, int]:
    host, sep, port = addr.rpartition(":")
    if not sep or not port.isdigit():
        raise ConfigError(f"TOLKTAK_LISTEN must be host:port or :port, got {addr!r}")
    host = host.strip("[]") or "0.0.0.0"
    return host, int(port)


def from_env() -> Config:
    embedded = _env("TOLKTAK_EMBEDDED_LIVEKIT") == "1"
    key, secret = _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")
    if not embedded and (not key or len(secret) < 32):
        raise ConfigError("LIVEKIT_API_KEY and LIVEKIT_API_SECRET (>= 32 chars) are required")
    reg = _env("TOLKTAK_REGISTRATION", "invite")
    if reg not in ("open", "invite", "closed"):
        raise ConfigError(f"TOLKTAK_REGISTRATION must be open, invite or closed, got {reg!r}")
    bucket = _env("TOLKTAK_S3_BUCKET")
    if bucket and not (_env("TOLKTAK_S3_ACCESS_KEY") and _env("TOLKTAK_S3_SECRET_KEY")):
        raise ConfigError("TOLKTAK_S3_ACCESS_KEY and TOLKTAK_S3_SECRET_KEY are required with TOLKTAK_S3_BUCKET")
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
    updates = _env("TOLKTAK_UPDATES", "manual")
    if updates not in ("auto", "manual", "off"):
        raise ConfigError(f"TOLKTAK_UPDATES must be auto, manual or off, got {updates!r}")
    return Config(
        server_name=_env("TOLKTAK_SERVER_NAME", "TolkTak"),
        registration=reg,
        livekit_public_url=_env("LIVEKIT_PUBLIC_URL"),
        signaling_public_url=_env("TOLKTAK_SIGNALING_PUBLIC_URL"),
        signaling_private=_env("TOLKTAK_SIGNALING_PRIVATE") == "1",
        livekit_internal_url=_env("LIVEKIT_INTERNAL_URL", "http://127.0.0.1:7880").rstrip("/"),
        livekit_api_key=key,
        livekit_api_secret=secret,
        embedded_livekit=embedded,
        client_download_url=_env("TOLKTAK_CLIENT_DOWNLOAD_URL"),
        trust_proxy=_env("TOLKTAK_TRUST_PROXY") == "1",
        data_dir=Path(_env("TOLKTAK_DATA_DIR", "./data")),
        database_url=db,
        s3_bucket=bucket,
        s3_endpoint=_env("TOLKTAK_S3_ENDPOINT"),
        s3_region=_env("TOLKTAK_S3_REGION"),
        s3_access_key=_env("TOLKTAK_S3_ACCESS_KEY"),
        s3_secret_key=_env("TOLKTAK_S3_SECRET_KEY"),
        max_upload_bytes=max_mb << 20,
        user_quota_bytes=quota_mb << 20,
        listen_host=host,
        listen_port=port,
        debug=_env("TOLKTAK_DEBUG") == "1",
        updates=updates,
        repository=_env("TOLKTAK_REPOSITORY", "D4eNst/tolktak"),
    )
