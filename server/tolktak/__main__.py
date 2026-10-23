import asyncio
import logging
import sys

import uvicorn

from . import __version__, logs
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
    from .app import create_app

    app = create_app(cfg)
    log.info(
        "tolktak-server listening addr=%s:%d version=%s registration=%s livekit=%s database=%s",
        cfg.listen_host, cfg.listen_port, __version__, cfg.registration, cfg.livekit_public_url,
        "postgres" if cfg.database_url.startswith("postgres") else "sqlite",
    )  # fmt: skip
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
    try:
        uvicorn.Server(config).run()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["version"]:
        print(__version__)
        return
    if args[:1] == ["copy-db"]:
        if len(args) != 3:
            print("usage: tolktak-server copy-db FROM_URL TO_URL", file=sys.stderr)
            sys.exit(2)
        logs.setup(False)
        from .copydb import copy

        sys.exit(asyncio.run(copy(args[1], args[2])))
    sys.exit(serve())


if __name__ == "__main__":
    main()
