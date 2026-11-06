import re
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from ..errors import ApiError, Forbidden, NotFound
from ..realtime import event
from ..server import current_user
from ..store import users
from .common import Body, json_response, path_id, read_json, server

router = APIRouter(prefix="/api/v1")
User = Annotated[dict, Depends(current_user)]
StrictID = Annotated[int, Field(strict=True, gt=0, lt=1 << 63)]


def _page_query(request: Request, directory: bool = False, contact_page: bool = False) -> dict:
    values = {}
    seen = set()
    for name, raw in request.query_params.multi_items():
        if name in seen:
            raise ApiError(400, "bad_request", "Repeated directory parameter")
        seen.add(name)
        if name == "q" and (directory or contact_page):
            if len(raw) > 256 or "\x00" in raw:
                raise ApiError(400, "bad_request", "Invalid directory query")
            values["query"] = raw
        elif name == "exclude" and directory:
            parts = raw.split(",")
            if not 1 <= len(parts) <= 200 or any(not re.fullmatch(r"[0-9]{1,19}", part) for part in parts):
                raise ApiError(400, "bad_request", "Invalid excluded user IDs")
            ids = [int(part) for part in parts]
            if len(set(ids)) != len(ids) or any(not 0 < uid < 1 << 63 for uid in ids):
                raise ApiError(400, "bad_request", "Invalid excluded user IDs")
            values["exclude"] = ids
        elif name == "relation" and contact_page and raw in {"contact", "incoming", "outgoing"}:
            values["relation"] = raw
        elif name in {"after", "limit"} and re.fullmatch(r"[0-9]{1,19}", raw):
            value = int(raw)
            if not 0 <= value < 1 << 63 or (name == "limit" and not 1 <= value <= 100):
                raise ApiError(400, "bad_request", "Invalid directory boundary")
            values[name] = value
        else:
            raise ApiError(400, "bad_request", "Invalid directory parameter")
    return values


def _online(request: Request, body: dict) -> dict:
    hub = server(request).hub
    return body | {"users": [u | {"online": hub.is_online(u["id"])} for u in body["users"]]}


@router.get("/users/directory")
async def directory(request: Request, user: User):
    body = await users.directory_page(user["id"], **_page_query(request, True))
    return json_response(_online(request, body))


@router.get("/users/dialogs")
async def dialogs(request: Request, user: User):
    body = await users.directory_page(user["id"], **_page_query(request, True), dialogs_only=True)
    return json_response(_online(request, body))


@router.get("/contacts")
async def contacts(request: Request, user: User):
    query = _page_query(request, contact_page=True)
    query.setdefault("relation", "contact")
    body = await users.directory_page(user["id"], **query)
    return json_response(_online(request, body))


class ProfilesReq(Body):
    ids: Annotated[list[StrictID], Field(max_length=100)]


@router.post("/users/profiles")
async def profiles(request: Request, user: User):
    req = await read_json(request, ProfilesReq)
    body = await users.profile_batch(user["id"], req.ids)
    return json_response(_online(request, body))


@router.get("/users/{id}")
async def profile(request: Request, user: User):
    uid = path_id(request)
    body = _online(request, await users.profile_batch(user["id"], [uid]))
    if not body["users"]:
        raise NotFound
    return json_response(
        {
            "user": body["users"][0],
            "contact": uid in body["contact_ids"],
            "relation": body["relations"].get(str(uid), users.no_relation()),
            "contacts_version": body["contacts_version"],
            "incoming_count": body["incoming_count"],
        }
    )


@router.get("/contacts/summary")
async def summary(request: Request, user: User):
    if request.query_params:
        raise ApiError(400, "bad_request", "Unexpected summary parameters")
    return json_response(await users.contact_summary(user["id"]))


class ActionReq(Body):
    request_id: Annotated[str, Field(strict=True, min_length=1)]


async def mutate(request: Request, user: dict, action: str):
    identity = None if action == "send" else (await read_json(request, ActionReq)).request_id
    try:
        states, changed = await users.change_contact(user["id"], path_id(request), action, identity)
    except Forbidden:
        raise ApiError(400, "bad_contact", "You cannot add yourself as a contact") from None
    if changed:
        for owner, state in states.items():
            server(request).hub.send_to([owner], event("contact.changed", state))
    return json_response(states[user["id"]])


@router.api_route("/contacts/{id}", methods=["PUT", "DELETE"])
async def contact(request: Request, user: User):
    return await mutate(request, user, "send" if request.method == "PUT" else "remove")


@router.post("/contacts/{id}/{action}")
async def action(request: Request, user: User):
    operation = request.path_params["action"]
    if operation not in {"accept", "decline", "cancel"}:
        raise ApiError(404, "not_found", "Unknown contact action")
    return await mutate(request, user, operation)
