import json
import os

import httpx
import pytest
from conftest import err_code, make_config

from tolktak import updates
from tolktak.config import ConfigError, from_env
from tolktak.errors import ApiError
from tolktak.realtime import Hub, VoiceMember
from tolktak.updates import MIN_CLIENT_VERSION, Updater, parse_version


def test_parse_version():
    assert parse_version("0.1.5") == (0, 1, 5)
    assert parse_version("v1.2.3") == (1, 2, 3)
    for v in ("0.1.0-dev", "", "1.2", "1.2.3.4"):
        assert parse_version(v) is None, v


def test_server_info_reports_min_client(make_env):
    e = make_env()
    code, body = e.do("GET", "/api/v1/server")
    assert code == 200
    assert body["min_client"] == MIN_CLIENT_VERSION


def test_hello_reports_min_client(make_env):
    e = make_env()
    token, _ = e.user("alice")
    with e.c.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        hello = json.loads(ws.receive_text())
    assert hello["type"] == "hello"
    assert hello["data"]["server"]["min_client"] == MIN_CLIENT_VERSION


async def _no_audience(room: str) -> list[int]:
    return []


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


class Rig:
    """An Updater on version 0.1.4 with a fake releases API, a live fake agent and one connected client."""

    def __init__(self, tmp_path, mode="auto", tag="v0.1.5", body=""):
        self.release = {"tag_name": tag, "body": body}
        self.clock = Clock()
        self.hub = Hub(_no_audience)
        self.conn = self.hub.register(1, b"")
        cfg = make_config(tmp_path, updates=mode)
        self.dir = cfg.updates_dir
        self.dir.mkdir(parents=True)
        self.beat()
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=self.release))
        self.up = Updater(cfg, "0.1.4", self.hub, transport=transport, clock=self.clock)

    def beat(self) -> None:
        agent = self.dir / "agent"
        agent.touch()
        os.utime(agent, (self.clock.t, self.clock.t))

    def request(self) -> str | None:
        f = self.dir / "request"
        return f.read_text().strip() if f.exists() else None

    def status(self, text: str) -> None:
        (self.dir / "status").write_text(text + "\n")

    def updates(self) -> list[dict]:
        out = []
        while not self.conn.queue.empty():
            b = self.conn.queue.get_nowait()
            ev = json.loads(b) if b else None
            if ev and ev["type"] == "server.update":
                out.append(ev["data"])
        return out


@pytest.fixture(autouse=True)
def no_restart_delay(monkeypatch):
    monkeypatch.setattr(updates, "RESTART_DELAY", 0)


def test_config_rejects_bad_updates_mode(monkeypatch):
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "x" * 32)
    monkeypatch.setenv("LIVEKIT_PUBLIC_URL", "ws://lk.test")
    monkeypatch.setenv("TOLKTAK_UPDATES", "sometimes")
    with pytest.raises(ConfigError):
        from_env()


def test_dev_version_disables_updater(tmp_path):
    hub = Hub(_no_audience)
    assert Updater(make_config(tmp_path), "0.1.0-dev", hub).enabled is False
    assert Updater(make_config(tmp_path, updates="off"), "0.1.4", hub).enabled is False
    assert Updater(make_config(tmp_path), "0.1.4", hub).enabled is True


async def test_check_finds_newer_release_and_pulls_in_auto(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    assert r.up.available is not None and r.up.available.version == "0.1.5"
    assert r.up.state == "pulling"
    assert r.request() == "pull 0.1.5"
    assert r.updates()[-1]["state"] == "pulling"


async def test_check_reads_the_releases_of_its_own_repository(tmp_path):
    seen = []

    def reply(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"tag_name": "v0.1.5", "body": ""})

    cfg = make_config(tmp_path, repository="someone/fork")
    up = Updater(cfg, "0.1.4", Hub(_no_audience), transport=httpx.MockTransport(reply))
    await up.check()
    assert seen == ["https://api.github.com/repos/someone/fork/releases/latest"]


async def test_check_ignores_same_version_and_errors(tmp_path):
    r = Rig(tmp_path, tag="v0.1.4")
    await r.up.check()
    assert r.up.available is None and r.request() is None

    def fail(request):
        raise httpx.ConnectError("offline")

    r.up.transport = httpx.MockTransport(fail)
    await r.up.check()
    assert r.up.state == "idle" and r.up.available is None


async def test_auto_waits_for_quiet_voice(tmp_path):
    r = Rig(tmp_path)
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "waiting" and r.request() == "pull 0.1.5"
    r.hub.voice.clear()
    await r.up.step()
    assert r.up.state == "restarting"
    assert r.request() == "apply 0.1.5"
    assert r.updates()[-1]["state"] == "restarting"


async def test_auto_applies_at_deadline_with_voice(tmp_path):
    r = Rig(tmp_path)
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "waiting"
    r.clock.t += 24 * 3600
    r.beat()
    await r.up.step()
    assert r.up.state == "restarting"


async def test_urgent_release_applies_right_after_pull(tmp_path):
    r = Rig(tmp_path, body="Fixes a security issue.\n\n<!-- tolktak:urgent -->\n")
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    assert r.up.available is not None and r.up.available.urgent
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "restarting"


async def test_manual_mode_waits_for_admin(tmp_path):
    r = Rig(tmp_path, mode="manual")
    await r.up.check()
    assert r.up.state == "idle" and r.request() is None
    assert r.up.available is not None
    await r.up.update_now()
    assert r.up.state == "pulling" and r.request() == "pull 0.1.5"
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "restarting"


async def test_failed_pull_reports_reason(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    r.status("failed 0.1.5 pull failed")
    await r.up.step()
    assert r.up.state == "failed" and r.up.error == "pull failed"


async def test_stale_status_is_ignored(tmp_path):
    r = Rig(tmp_path)
    r.status("pulled 0.1.4")
    await r.up.check()
    assert not (r.dir / "status").exists()
    await r.up.step()
    assert r.up.state == "pulling"


async def test_newer_release_replaces_waiting_one(tmp_path):
    r = Rig(tmp_path)
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "waiting"
    r.release = {**r.release, "tag_name": "v0.1.6"}
    await r.up.check()
    assert r.up.available is not None and r.up.available.version == "0.1.6"
    assert r.up.state == "pulling" and r.request() == "pull 0.1.6"


async def test_events_carry_only_state_and_version(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    assert r.updates()[-1] == {"state": "pulling", "version": "0.1.5"}


async def test_dead_agent_keeps_waiting(tmp_path):
    r = Rig(tmp_path)
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    r.hub.voice.clear()
    r.clock.t += updates.AGENT_FRESH + 1
    await r.up.step()
    assert r.up.state == "waiting" and r.request() == "pull 0.1.5"


async def test_restart_timeout_fails_and_drops_request(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    await r.up.step()
    assert r.up.state == "restarting" and r.request() == "apply 0.1.5"
    r.clock.t += updates.APPLY_TIMEOUT + 1
    await r.up.step()
    assert r.up.state == "failed" and r.up.error == "server was not restarted"
    assert r.request() is None


async def test_failed_apply_reports_reason(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    await r.up.step()
    assert r.up.state == "restarting"
    r.status("failed 0.1.5 compose failed")
    await r.up.step()
    assert r.up.state == "failed" and r.up.error == "compose failed"
    assert r.request() is None


async def test_pull_timeout(tmp_path):
    r = Rig(tmp_path)
    await r.up.check()
    r.clock.t += updates.PULL_TIMEOUT + 1
    await r.up.step()
    assert r.up.state == "failed" and r.up.error == "pull timed out"
    assert r.request() is None


async def test_update_now_in_auto_mode(tmp_path):
    r = Rig(tmp_path / "pulling")
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    await r.up.update_now()
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "restarting"

    r = Rig(tmp_path / "waiting")
    r.hub.voice["g1r1"] = {2: VoiceMember(user_id=2)}
    await r.up.check()
    r.status("pulled 0.1.5")
    await r.up.step()
    assert r.up.state == "waiting"
    await r.up.update_now()
    assert r.up.state == "restarting"


async def test_manual_update_survives_newer_release(tmp_path):
    r = Rig(tmp_path, mode="manual")
    await r.up.check()
    await r.up.update_now()
    r.release = {**r.release, "tag_name": "v0.1.6"}
    await r.up.check()
    assert r.up.state == "pulling" and r.request() == "pull 0.1.6"
    r.status("pulled 0.1.6")
    await r.up.step()
    assert r.up.state == "restarting"


async def test_manual_mode_waits_for_admin_even_when_urgent(tmp_path):
    r = Rig(tmp_path, mode="manual", body="<!-- tolktak:urgent -->")
    await r.up.check()
    assert r.up.state == "idle" and r.request() is None


async def test_update_now_errors(tmp_path):
    r = Rig(tmp_path, mode="manual", tag="v0.1.4")
    await r.up.check()
    with pytest.raises(ApiError) as e:
        await r.up.update_now()
    assert e.value.code == "no_update"
    r.release = {**r.release, "tag_name": "v0.1.5"}
    await r.up.check()
    (r.dir / "agent").unlink()
    with pytest.raises(ApiError) as e:
        await r.up.update_now()
    assert e.value.code == "no_agent"


def test_admin_update_endpoints(make_env):
    e = make_env()
    admin, _ = e.user("admin")
    user, _ = e.user("bob")
    code, body = e.do("GET", "/api/v1/admin/update", admin)
    assert code == 200
    assert set(body) == {"version", "mode", "enabled", "agent", "available", "state", "error", "apply_by"}
    code, _ = e.do("GET", "/api/v1/admin/update", user)
    assert code == 403
    code, body = e.do("POST", "/api/v1/admin/update", admin)
    assert code == 409 and err_code(body) == "no_update"
