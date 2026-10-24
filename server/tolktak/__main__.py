import asyncio
import logging
import os
import sys
from dataclasses import replace

import uvicorn

from . import __version__, livekit_process, logs
from .config import ConfigError, from_env

log = logging.getLogger("tolktak")


def serve() -> int:
    try:
        cfg = from_env()
    except ConfigError as e:
        logs.setup(False)
        log.error("fatal: %s", e)
        return 1
    logs.setup(cfg.debug)
    if cfg.embedded_livekit:
        cfg.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        key, secret = livekit_process.load_keys(cfg.data_dir)
        cfg = replace(
            cfg,
            livekit_api_key=key,
            livekit_api_secret=secret,
            livekit_internal_url=f"http://127.0.0.1:{livekit_process.PORT}",
        )
    from .app import create_app

    app = create_app(cfg)
    log.info(
        "tolktak-server listening addr=%s:%d version=%s registration=%s livekit=%s database=%s files=%s",
        cfg.listen_host, cfg.listen_port, __version__, cfg.registration, cfg.livekit_public_url or "auto",
        "postgres" if cfg.database_url.startswith("postgres") else "sqlite", "s3" if cfg.s3_bucket else "disk",
    )  # fmt: skip
    if not cfg.trust_proxy:
        log.warning(
            "serving plain HTTP: open http://<server address>:%d; passwords and messages cross the network "
            "unencrypted, so put a reverse proxy with TLS in front of a server on the internet",
            cfg.listen_port,
        )
    config = uvicorn.Config(
        app,
        host=cfg.listen_host,
        port=cfg.listen_port,
        loop="auto",
        http="auto",
        ws="websockets-sansio",
        ws_max_size=64 << 10,
        ws_ping_interval=None,
        # X-Forwarded-For is handled by the app only when TOLKTAK_TRUST_PROXY=1.
        proxy_headers=False,
        server_header=False,
        date_header=True,
        timeout_graceful_shutdown=10,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(config)
    if cfg.embedded_livekit:
        return livekit_process.run_with(server, cfg)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["version"]:
        print(__version__)
        return
    if args[:1] == ["copy-db"]:
        if len(args) not in (2, 3):
            print("usage: tolktak-server copy-db FROM_URL [TO_URL, default TOLKTAK_DATABASE_URL]", file=sys.stderr)
            sys.exit(2)
        logs.setup(False)
        from .copydb import copy

        to = args[2] if len(args) == 3 else os.environ.get("TOLKTAK_DATABASE_URL", "")
        sys.exit(asyncio.run(copy(args[1], to)))
    if args[:1] == ["copy-files"]:
        if len(args) != 1:
            print("usage: tolktak-server copy-files", file=sys.stderr)
            sys.exit(2)
        logs.setup(False)
        from .storage import copy_files

        try:
            cfg = from_env()
        except ConfigError as e:
            log.error("fatal: %s", e)
            sys.exit(1)
        sys.exit(asyncio.run(copy_files(cfg)))
    sys.exit(serve())


if __name__ == "__main__":
    main()
