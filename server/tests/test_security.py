def test_forwarded_for_uses_the_address_the_proxy_added(make_env):
    e = make_env(trust_proxy=True)
    codes = [
        e.c.post(
            "/api/v1/auth/register",
            json={"username": f"user{i}", "password": "password123"},
            headers={"X-Forwarded-For": f"10.9.8.{i}, 203.0.113.7"},
        ).status_code
        for i in range(8)
    ]
    assert 429 in codes, "addresses the client put in front of the proxy's must not reset the limit"
