import base64
import hashlib
import hmac
import time

import httpx
import orjson

PUBLISH_SOURCES = ["microphone", "camera", "screen_share", "screen_share_audio"]


class WebhookError(Exception):
    pass


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


_HEADER = _b64url(b'{"alg":"HS256","typ":"JWT"}')


class LiveKit:
    def __init__(self, api_key: str, api_secret: str, internal_url: str):
        self.api_key = api_key
        self.secret = api_secret.encode()
        self.internal_url = internal_url.rstrip("/")
        self.http = httpx.AsyncClient(timeout=5.0)

    async def close(self) -> None:
        await self.http.aclose()

    def sign(self, claims: dict) -> str:
        unsigned = _HEADER + "." + _b64url(orjson.dumps(claims))
        sig = hmac.new(self.secret, unsigned.encode(), hashlib.sha256).digest()
        return unsigned + "." + _b64url(sig)

    def verify(self, token: str) -> dict:
        parts = token.split(".")
        if len(parts) != 3:
            raise WebhookError("malformed token")
        want = hmac.new(self.secret, (parts[0] + "." + parts[1]).encode(), hashlib.sha256).digest()
        try:
            sig = _unb64url(parts[2])
            claims = orjson.loads(_unb64url(parts[1]))
        except ValueError as e:
            raise WebhookError("malformed token") from e
        if not hmac.compare_digest(sig, want):
            raise WebhookError("bad signature")
        now = int(time.time())
        exp, nbf = claims.get("exp", 0), claims.get("nbf", 0)
        if claims.get("iss") != self.api_key or (exp and now > exp + 30) or (nbf and now + 30 < nbf):
            raise WebhookError("token not valid now or wrong issuer")
        return claims

    def join_token(self, identity: str, name: str, metadata: str, room: str, ttl: int) -> str:
        now = int(time.time())
        claims = {"iss": self.api_key, "sub": identity, "nbf": now - 10, "exp": now + ttl}
        if name:
            claims["name"] = name
        if metadata:
            claims["metadata"] = metadata
        claims["video"] = {
            "roomJoin": True, "room": room, "canPublish": True, "canSubscribe": True, "canPublishData": True,
            "canPublishSources": PUBLISH_SOURCES,
        }  # fmt: skip
        return self.sign(claims)

    def receive_webhook(self, authorization: str, body: bytes) -> dict:
        """The webhook is a JWT whose sha256 claim covers the body."""
        claims = self.verify(authorization.removeprefix("Bearer "))
        if claims.get("sha256") != base64.b64encode(hashlib.sha256(body).digest()).decode():
            raise WebhookError("webhook body hash mismatch")
        try:
            return orjson.loads(body)
        except orjson.JSONDecodeError as e:
            raise WebhookError("malformed webhook body") from e

    async def _twirp(self, method: str, grant: dict, req: dict) -> dict:
        now = int(time.time())
        tok = self.sign({"iss": self.api_key, "nbf": now - 10, "exp": now + 60, "video": grant})
        res = await self.http.post(
            f"{self.internal_url}/twirp/livekit.RoomService/{method}",
            content=orjson.dumps(req),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok},
        )
        if res.status_code != 200:
            raise RuntimeError(f"livekit {method}: {res.status_code}: {res.text[:4096]}")
        return res.json()

    async def list_rooms(self) -> list[dict]:
        return (await self._twirp("ListRooms", {"roomList": True}, {})).get("rooms") or []

    async def list_participants(self, room: str) -> list[dict]:
        resp = await self._twirp("ListParticipants", {"roomAdmin": True, "room": room}, {"room": room})
        return resp.get("participants") or []

    async def remove_participant(self, room: str, identity: str) -> None:
        await self._twirp("RemoveParticipant", {"roomAdmin": True, "room": room}, {"room": room, "identity": identity})
