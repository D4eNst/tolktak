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


def test_login_attempts_are_limited_per_address(make_env):
    e = make_env()
    codes = [
        e.do("POST", "/api/v1/auth/login", body={"username": f"name{i}", "password": "wrong"})[0] for i in range(12)
    ]
    assert 429 in codes, "one address must not try names without limit"


def test_login_attempts_are_limited_per_account(make_env):
    e = make_env(trust_proxy=True)
    e.user("alice")
    codes = [
        e.c.post(
            "/api/v1/auth/login",
            json={"username": " " * i + "ALICE", "password": "wrong-password"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        ).status_code
        for i in range(12)
    ]
    assert 429 in codes, "spelling the name differently or changing address must not reset the account's limit"
