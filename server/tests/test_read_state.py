import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tolktak import db


def conversation(e):
    alice, alice_id = e.user("alice")
    bob, bob_id = e.user("bob")
    _, body = e.do("POST", "/api/v1/dms", alice, {"user_id": bob_id})
    return alice, alice_id, bob, bob_id, body["channel"]["id"]


def send(e, token, cid, text, nonce=None):
    code, body = e.do("POST", f"/api/v1/channels/{cid}/messages", token, {"text": text, "nonce": nonce or text})
    assert code == 200, body
    return body["message"]


def state(e, token, cid):
    code, body = e.do("GET", f"/api/v1/channels/{cid}/read", token)
    assert code == 200, body
    return body


def read(e, token, cid, mid):
    code, body = e.do("POST", f"/api/v1/channels/{cid}/read", token, {"message_id": mid})
    assert code == 200, body
    return body


@pytest.mark.parametrize("message_id", [None, 0, -1, 1 << 63, True, 1.5, "1"])
def test_read_rejects_invalid_ids_without_changing_state(make_env, message_id):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    send(e, bob, cid, "unread")
    before = state(e, alice, cid)
    code, body = e.do("POST", f"/api/v1/channels/{cid}/read", alice, {"message_id": message_id})
    assert code == 400, body
    assert state(e, alice, cid) == before


def test_read_rejects_foreign_messages_and_non_members(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    carol, carol_id = e.user("carol")
    _, body = e.do("POST", "/api/v1/dms", bob, {"user_id": carol_id})
    foreign = send(e, bob, body["channel"]["id"], "private")
    own = send(e, bob, cid, "visible")
    before = state(e, alice, cid)
    for mid in (foreign["id"], own["id"] + 1000):
        assert e.do("POST", f"/api/v1/channels/{cid}/read", alice, {"message_id": mid})[0] == 404
        assert state(e, alice, cid) == before
    assert e.do("GET", f"/api/v1/channels/{cid}/read", carol)[0] == 404
    assert e.do("POST", f"/api/v1/channels/{cid}/read", carol, {"message_id": own["id"]})[0] == 404


def test_partial_and_stale_reads_return_the_actual_cursor_and_unread(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    messages = [send(e, bob, cid, f"message-{i}") for i in range(4)]
    initial = state(e, alice, cid)
    assert initial["message_id"] == 0 and initial["unread"] == 4
    partial = read(e, alice, cid, messages[1]["id"])
    assert partial == {
        "channel_id": cid,
        "message_id": messages[1]["id"],
        "unread": 2,
        "history_version": initial["history_version"],
    }
    latest = read(e, alice, cid, messages[3]["id"])
    assert latest["unread"] == 0
    assert read(e, alice, cid, messages[0]["id"]) == latest
    assert state(e, alice, cid) == latest


def test_sending_and_retrying_do_not_read_the_unseen_gap(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    messages = [send(e, bob, cid, f"gap-{i}") for i in range(3)]
    first = read(e, alice, cid, messages[0]["id"])
    assert first["unread"] == 2
    sent = send(e, alice, cid, "reply from another view", "same-send")
    assert send(e, alice, cid, "reply from another view", "same-send")["id"] == sent["id"]
    after = state(e, alice, cid)
    assert after["message_id"] == messages[0]["id"]
    assert after["unread"] == 2
    assert after["history_version"] > first["history_version"]


def test_read_accepts_an_observed_deleted_message_and_excludes_own_and_deleted(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    first = send(e, bob, cid, "first")
    deleted = send(e, bob, cid, "removed")
    send(e, alice, cid, "own")
    send(e, bob, cid, "last")
    assert e.do("DELETE", f"/api/v1/messages/{deleted['id']}", bob)[0] == 200
    assert state(e, alice, cid)["unread"] == 2
    after = read(e, alice, cid, deleted["id"])
    assert after["message_id"] == deleted["id"] and after["unread"] == 1
    assert read(e, alice, cid, first["id"]) == after


def test_read_snapshot_is_the_same_for_http_and_all_user_devices(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    messages = [send(e, bob, cid, f"device-{i}") for i in range(3)]
    with e.c.websocket_connect("/api/v1/ws") as first, e.c.websocket_connect("/api/v1/ws") as second:
        for ws in (first, second):
            ws.send_json({"type": "auth", "token": alice})
            while json.loads(ws.receive_text())["type"] != "hello":
                pass
        actual = read(e, alice, cid, messages[0]["id"])
        assert actual["unread"] == 2
        for ws in (first, second):
            while (frame := json.loads(ws.receive_text()))["type"] != "channel.read":
                pass
            assert frame["data"] == actual


def test_concurrent_reads_keep_the_farthest_confirmed_cursor(make_env):
    e = make_env()
    alice, _, bob, _, cid = conversation(e)
    e.server.rl.disabled = True
    messages = [send(e, bob, cid, f"parallel-{i}") for i in range(12)]
    ids = [m["id"] for m in messages]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda mid: read(e, alice, cid, mid), reversed(ids)))
    assert all(r["message_id"] >= mid for r, mid in zip(results, reversed(ids), strict=True))
    assert state(e, alice, cid)["message_id"] == ids[-1]
    assert state(e, alice, cid)["unread"] == 0


def test_read_snapshot_requires_current_membership(make_env):
    e = make_env()
    alice, alice_id, bob, _, cid = conversation(e)
    message = send(e, bob, cid, "membership")
    e.c.portal.call(db.execute, "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?", [cid, alice_id])
    assert e.do("GET", f"/api/v1/channels/{cid}/read", alice)[0] == 404
    assert e.do("POST", f"/api/v1/channels/{cid}/read", alice, {"message_id": message["id"]})[0] == 404
