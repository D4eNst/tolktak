import base64

from conftest import err_code

# 1x1 transparent PNG.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def test_files_replies_reactions_pins(make_env):
    e = make_env()
    alice, _ = e.user("alice")
    bob, bob_id = e.user("bob")
    carol, _ = e.user("carol")

    code, body = e.upload(alice, "cat.png", TINY_PNG)
    assert code == 201, body
    f = body["file"]
    assert f["mime"] == "image/png" and f["width"] == 1
    fid = f["id"]
    r = e.c.get(f"/api/v1/files/{fid}")
    assert r.content == TINY_PNG and r.headers["content-type"] == "image/png"
    assert r.headers.get("content-security-policy")
    assert e.upload(alice, "big.bin", bytes(2 << 20))[0] == 413

    _, body = e.do("POST", "/api/v1/dms", alice, {"user_id": bob_id})
    path = f"/api/v1/channels/{body['channel']['id']}"
    _, body = e.do("POST", path + "/messages", alice, {"text": "", "nonce": "n1", "attachments": [fid]})
    first = body["message"]
    assert len(first["attachments"]) == 1
    code, res = e.do("POST", path + "/messages", bob, {"text": "x", "nonce": "b0", "attachments": [fid]})
    assert (code, err_code(res)) == (403, "bad_file")
    _, body = e.do("POST", path + "/messages", bob, {"text": "**nice**", "nonce": "b1", "reply_to": first["id"]})
    assert body["message"]["reply"]["attachments"] == 1
    mpath = f"/api/v1/messages/{first['id']}"
    e.do("POST", mpath + "/reactions", bob, {"emoji": "🔥"})
    _, body = e.do("POST", mpath + "/reactions", alice, {"emoji": "🔥"})
    r = body["message"]["reactions"]
    assert len(r) == 1 and len(r[0]["users"]) == 2
    _, body = e.do("POST", mpath + "/reactions", bob, {"emoji": "🔥"})
    assert len(body["message"]["reactions"][0]["users"]) == 1
    assert e.do("POST", mpath + "/reactions", carol, {"emoji": "🔥"})[0] == 404
    assert e.do("POST", mpath + "/pin", bob)[0] == 200, "DM participant may pin"
    _, body = e.do("GET", path + "/pins", alice)
    assert len(body["messages"]) == 1
    _, body = e.do("GET", path + "/messages?q=NICE", alice)
    assert len(body["messages"]) == 1
    code, res = e.do("DELETE", mpath, bob)
    assert (code, err_code(res)) == (403, "not_own_message")

    code, body = e.do("PATCH", "/api/v1/me", alice, {"avatar": fid, "status": "смотрю кино", "about": "привет"})
    assert code == 200 and body["user"]["avatar"] == fid
    assert e.do("PATCH", "/api/v1/me", bob, {"avatar": fid})[0] == 400


def test_group_roles_and_text_channels(make_env):
    e = make_env()
    owner, _ = e.user("owner")
    mod, mod_id = e.user("moder")
    mem, mem_id = e.user("member")
    _, other = e.user("other")
    _, body = e.do("POST", "/api/v1/groups", owner, {"name": "Кино", "members": [mod_id, mem_id, other]})
    g = body["group"]
    gid = g["id"]
    assert len(g["text_channels"]) == 1
    code, res = e.do("POST", f"/api/v1/groups/{gid}/channels", mod, {"name": "мемы"})
    assert (code, err_code(res)) == (403, "moderators_only")
    code, res = e.do("PUT", f"/api/v1/groups/{gid}/members/{mod_id}/role", mod, {"role": "mod"})
    assert (code, err_code(res)) == (403, "owner_only")
    assert e.do("PUT", f"/api/v1/groups/{gid}/members/{mod_id}/role", owner, {"role": "mod"})[0] == 204
    code, body = e.do("POST", f"/api/v1/groups/{gid}/channels", mod, {"name": "мемы"})
    assert code == 201, body
    assert body["channel"]["position"] == 1, "the main chat is at position 0"
    tc = body["channel"]["id"]
    assert e.do("POST", f"/api/v1/channels/{tc}/messages", mem, {"text": "привет", "nonce": "m1"})[0] == 200
    _, body = e.do("GET", "/api/v1/channels", mem)
    assert any(c["id"] == tc and c["group_id"] == gid for c in body["channels"])
    _, body = e.do("POST", f"/api/v1/channels/{tc}/messages", mem, {"text": "спам", "nonce": "m2"})
    spam = body["message"]["id"]
    assert e.do("DELETE", f"/api/v1/messages/{spam}", mod)[0] == 200
    assert e.do("DELETE", f"/api/v1/groups/{gid}/members/{mem_id}", mod)[0] == 204
    assert e.do("GET", f"/api/v1/channels/{tc}/messages", mem)[0] == 404, "kicked member loses access"
    _, body = e.do("GET", "/api/v1/groups", owner)
    owner_id = body["groups"][0]["owner_id"]
    code, res = e.do("DELETE", f"/api/v1/groups/{gid}/members/{owner_id}", mod)
    assert (code, err_code(res)) == (403, "cannot_kick_owner")
    code, res = e.do("DELETE", f"/api/v1/text-channels/{g['channel_id']}", owner)
    assert (code, err_code(res)) == (400, "main_channel")
    assert e.do("DELETE", f"/api/v1/text-channels/{tc}", mod)[0] == 204
    assert e.do("DELETE", f"/api/v1/groups/{gid}", owner)[0] == 204


def test_search_ignores_case_beyond_ascii(make_env):
    e = make_env()
    a, _ = e.user("alice")
    _, b_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", a, {"user_id": b_id})
    path = f"/api/v1/channels/{body['channel']['id']}/messages"
    e.do("POST", path, a, {"text": "Привет, Мир", "nonce": "n1"})
    for q in ("Привет", "привет", "ПРИВЕТ", "мир"):
        assert len(e.do("GET", f"{path}?q={q}", a)[1]["messages"]) == 1, q
