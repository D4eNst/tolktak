import pytest


@pytest.mark.parametrize("path", ["/", "/admin", "/docs", "/static/site.css", "/static/i18n.js", "/static/docs.js"])
def test_pages_served(make_env, path):
    r = make_env().c.get(path)
    assert r.status_code == 200 and r.content
