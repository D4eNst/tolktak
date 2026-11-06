import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from ..errors import ApiError
from ..server import current_user
from ..store import moderation as store
from .common import Body, json_response, path_id, read_json, server

router = APIRouter(prefix="/api/v1")
User = Annotated[dict, Depends(current_user)]
Media = Literal["microphone", "camera", "screen"]


class RuleReq(Body):
    duration: Literal["time", "call", "permanent"]
    seconds: Annotated[int | None, Field(strict=True, ge=1, le=31536000)] = None


class OffReq(Body):
    source: Media


@router.get("/rooms/{id}/permissions")
async def permissions(request: Request, user: User):
    return json_response(await server(request).moderation.permissions(path_id(request), user["id"]))


@router.get("/rooms/{id}/moderation")
async def rules(request: Request, user: User):
    values = {}
    for name, raw in request.query_params.multi_items():
        if name not in {"after", "limit"} or name in values or not re.fullmatch(r"[0-9]{1,19}", raw):
            raise ApiError(400, "bad_request", "Invalid moderation page")
        value = int(raw)
        if not 0 <= value < 1 << 63 or name == "limit" and not 1 <= value <= 100:
            raise ApiError(400, "bad_request", "Invalid moderation boundary")
        values[name] = value
    body = await store.rule_page(path_id(request), user["id"], **values)
    hub = server(request).hub
    body["users"] = [u | {"online": hub.is_online(u["id"])} for u in body["users"]]
    return json_response(body)


def target(request: Request, me: int) -> int:
    uid = path_id(request, "uid")
    if uid == me:
        raise ApiError(400, "bad_target", "Use your own call controls")
    return uid


@router.api_route("/rooms/{id}/moderation/{uid}/{source}", methods=["PUT", "DELETE"])
async def rule(request: Request, user: User):
    source = request.path_params["source"]
    if source not in store.SOURCES:
        raise ApiError(400, "bad_request", "Unknown media source")
    uid = target(request, user["id"])
    duration = seconds = None
    if request.method == "PUT":
        req = await read_json(request, RuleReq)
        if (req.duration == "time") != (req.seconds is not None) or source == "entry" and req.duration != "call":
            raise ApiError(400, "bad_request", "Invalid restriction duration")
        duration, seconds = req.duration, req.seconds
    action = "clear" if duration is None else ("kick" if source == "entry" else "set")
    return json_response(
        await server(request).moderation.mutate(path_id(request), user["id"], uid, source, action, duration, seconds)
    )


@router.post("/rooms/{id}/participants/{uid}/off")
async def off(request: Request, user: User):
    req = await read_json(request, OffReq)
    return json_response(
        await server(request).moderation.mutate(
            path_id(request), user["id"], target(request, user["id"]), req.source, "off"
        )
    )


@router.post("/rooms/{id}/participants/{uid}/kick")
async def kick(request: Request, user: User):
    return json_response(
        await server(request).moderation.mutate(
            path_id(request), user["id"], target(request, user["id"]), "entry", "kick", "call"
        )
    )
