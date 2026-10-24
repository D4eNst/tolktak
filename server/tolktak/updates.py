import asyncio
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass

import httpx

from .config import Config
from .errors import ApiError
from .realtime import Hub, event

log = logging.getLogger("tolktak")

# Raise when a release breaks older clients; clients below it must update before they can work.
MIN_CLIENT_VERSION = "0.1.3"

URGENT_MARK = "<!-- tolktak:urgent -->"
FIRST_CHECK = 60
CHECK_EVERY = 60 * 60
WAIT_FOR_QUIET = 24 * 60 * 60
AGENT_FRESH = 30
PULL_TIMEOUT = 10 * 60
APPLY_TIMEOUT = 5 * 60
RESTART_DELAY = 1

_VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def parse_version(v: str) -> tuple[int, int, int] | None:
    """Release versions only: developer builds such as 0.1.0-dev give None."""
    m = _VERSION.fullmatch(v)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


@dataclass
class Release:
    version: str
    urgent: bool


class Updater:
    """Decides when the server updates; the updater sidecar pulls the image and recreates the container.

    They talk through files in the updates directory. The server writes `request`
    ("pull 1.2.3" or "apply 1.2.3"), the sidecar answers in `status` ("pulled 1.2.3" or
    "failed 1.2.3 <reason>") and touches `agent` while it runs.
    """

    def __init__(
        self,
        cfg: Config,
        version: str,
        hub: Hub,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.mode = cfg.updates
        self.releases = f"https://api.github.com/repos/{cfg.repository}/releases/latest"
        self.version = version
        self.dir = cfg.updates_dir
        self.hub = hub
        self.transport = transport
        self.clock = clock
        self.state = "idle"
        self.error = ""
        self.available: Release | None = None
        self.apply_by = 0.0
        self.apply_when_pulled = False
        self.since = 0.0

    @property
    def enabled(self) -> bool:
        return self.mode != "off" and parse_version(self.version) is not None

    def agent_alive(self) -> bool:
        try:
            return (self.dir / "agent").stat().st_mtime > self.clock() - AGENT_FRESH
        except OSError:
            return False

    def snapshot(self) -> dict:
        return {
            "version": self.version,
            "mode": self.mode,
            "enabled": self.enabled,
            "agent": self.agent_alive(),
            "available": asdict(self.available) if self.available else None,
            "state": self.state,
            "error": self.error,
            "apply_by": int(self.apply_by * 1000) if self.available else None,
        }

    async def run(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        next_check = self.clock() + FIRST_CHECK
        while True:
            try:
                if self.clock() >= next_check:
                    next_check = self.clock() + CHECK_EVERY
                    await self.check()
                await self.step()
            except Exception:
                log.exception("updates")
            await asyncio.sleep(5)

    async def check(self) -> None:
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15) as c:
                headers = {"Accept": "application/vnd.github+json", "User-Agent": f"tolktak-server/{self.version}"}
                r = await c.get(self.releases, headers=headers)
                r.raise_for_status()
                release = r.json()
            latest = parse_version(release["tag_name"])
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            log.warning("update check failed: %r", e)
            return
        current = parse_version(self.version)
        if latest is None or current is None or latest <= current:
            return
        version = ".".join(map(str, latest))
        if self.available is None or self.available.version != version:
            urgent = URGENT_MARK in (release.get("body") or "")
            self.available = Release(version, urgent)
            self.apply_by = self.clock() + WAIT_FOR_QUIET
            # An administrator's "Update now" carries over to the newer release.
            self.apply_when_pulled = self.apply_when_pulled or (urgent and self.mode == "auto")
            log.info("update available version=%s urgent=%s", version, urgent)
            if self.state != "restarting":
                self._set("idle")
        wanted = self.mode == "auto" or self.apply_when_pulled
        if wanted and self.state in ("idle", "failed") and self.agent_alive():
            self._pull(version)

    async def step(self) -> None:
        a = self.available
        if a is None:
            return
        match self.state:
            case "pulling":
                status = self._status().split(maxsplit=2)
                if status[:2] == ["pulled", a.version]:
                    if self.apply_when_pulled:
                        await self._restart(a.version)
                    else:
                        self._set("waiting")
                elif status[:2] == ["failed", a.version]:
                    self._fail(status[2] if len(status) > 2 else "update failed")
                elif self.clock() > self.since + PULL_TIMEOUT:
                    self._fail("pull timed out")
            case "waiting":
                if not self.agent_alive():
                    return
                if self.apply_when_pulled or not self.hub.voice or self.clock() >= self.apply_by:
                    await self._restart(a.version)
            case "restarting":
                status = self._status().split(maxsplit=2)
                if status[:2] == ["failed", a.version]:
                    self._fail(status[2] if len(status) > 2 else "update failed")
                elif self.clock() > self.since + APPLY_TIMEOUT:
                    self._fail("server was not restarted")

    async def update_now(self) -> None:
        a = self.available
        if not self.enabled or a is None:
            raise ApiError(409, "no_update", "No update is available")
        if self.state == "restarting":
            return
        if self.state == "pulling":
            self.apply_when_pulled = True
            return
        if not self.agent_alive():
            raise ApiError(409, "no_agent", "The updater is not running; update the server manually")
        if self.state == "waiting":
            await self._restart(a.version)
        else:
            self.apply_when_pulled = True
            self._pull(a.version)

    def _pull(self, version: str) -> None:
        (self.dir / "status").unlink(missing_ok=True)
        self._request("pull", version)
        self.since = self.clock()
        self._set("pulling")

    async def _restart(self, version: str) -> None:
        (self.dir / "status").unlink(missing_ok=True)
        self.since = self.clock()
        self._set("restarting")
        # Gives clients time to receive the notice before the container stops.
        await asyncio.sleep(RESTART_DELAY)
        self._request("apply", version)
        log.info("restarting for update version=%s", version)

    def _request(self, action: str, version: str) -> None:
        tmp = self.dir / "request.tmp"
        tmp.write_text(f"{action} {version}\n")
        os.replace(tmp, self.dir / "request")

    def _status(self) -> str:
        try:
            return (self.dir / "status").read_text().strip()
        except OSError:
            return ""

    def _fail(self, reason: str) -> None:
        # A request left behind would be carried out whenever the sidecar comes back, without warning.
        (self.dir / "request").unlink(missing_ok=True)
        self.apply_when_pulled = self.mode == "auto" and self.available is not None and self.available.urgent
        self._set("failed", reason)

    def _set(self, state: str, error: str = "") -> None:
        self.state, self.error = state, error
        # Administrators fetch the details; everyone needs to know a restart is coming.
        version = self.available.version if self.available else None
        self.hub.broadcast_all(event("server.update", {"state": state, "version": version}))
