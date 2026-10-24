import logging
import os
import secrets
import signal
import subprocess
import threading
from pathlib import Path

import orjson
import uvicorn

from .config import Config

log = logging.getLogger("tolktak")

PORT = 7880


def load_keys(data_dir: Path) -> tuple[str, str]:
    path = data_dir / "livekit-keys"
    keys = path.read_text().split() if path.exists() else []
    if len(keys) != 2:
        keys = [f"tk{secrets.token_hex(6)}", secrets.token_hex(32)]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(" ".join(keys) + "\n")
    return keys[0], keys[1]


def livekit_config(cfg: Config) -> dict:
    host = "127.0.0.1" if cfg.listen_host in ("", "0.0.0.0", "::") else cfg.listen_host
    if ":" in host:
        host = f"[{host}]"
    return {
        "port": PORT,
        # STUN discovery overrides NODE_IP, so an explicit address turns it off.
        "rtc": {"tcp_port": 7881, "udp_port": 7882, "use_external_ip": not os.environ.get("NODE_IP")},
        "keys": {cfg.livekit_api_key: cfg.livekit_api_secret},
        "webhook": {
            "api_key": cfg.livekit_api_key,
            "urls": [f"http://{host}:{cfg.listen_port}/api/v1/livekit/webhook"],
        },
        "room": {
            "empty_timeout": 60,
            # Adds H.264 42001f: Chromium encodes it on the GPU, the default 42e01f only in software.
            "enabled_codecs": [
                {"mime": "audio/opus"},
                {"mime": "audio/red"},
                {"mime": "audio/PCMU"},
                {"mime": "audio/PCMA"},
                {
                    "mime": "video/H264",
                    "fmtp_line": "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
                },
                {"mime": "video/H264"},
                {"mime": "video/VP8"},
                {"mime": "video/VP9"},
                {"mime": "video/AV1"},
                {"mime": "video/H265"},
                {"mime": "video/rtx"},
            ],
        },
        "turn": {"enabled": False},
        "logging": {"level": "info"},
    }


def start(cfg: Config) -> subprocess.Popen:
    env = {**os.environ, "LIVEKIT_CONFIG": orjson.dumps(livekit_config(cfg)).decode()}
    return subprocess.Popen(["livekit-server"], env=env)


def run_with(server: uvicorn.Server, cfg: Config) -> int:
    """Runs the server next to livekit-server: when either stops, both stop."""
    proc = start(cfg)
    died = False

    def watch() -> None:
        nonlocal died
        code = proc.wait()
        if not server.should_exit:
            log.error("livekit-server exited code=%d", code)
            died = True
            server.should_exit = True

    threading.Thread(target=watch, daemon=True).start()
    # uvicorn re-raises SIGTERM after shutdown, which would skip the finally below when not PID 1.
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        server.should_exit = True
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
    return 1 if died else 0
