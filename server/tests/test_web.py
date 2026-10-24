import pytest

from tolktak import db


@pytest.mark.parametrize("path", ["/", "/admin", "/docs", "/static/site.css", "/static/i18n.js", "/static/docs.js"])
def test_pages_served(make_env, path):
    r = make_env().c.get(path)
    assert r.status_code == 200 and r.content


def test_health_check_reports_the_database(make_env, monkeypatch):
    e = make_env()
    assert e.c.get("/healthz").text == "ok"

    async def broken(*_):
        raise OSError("database is down")

    monkeypatch.setattr(db, "rows", broken)
    assert e.c.get("/healthz").status_code == 503
