import contextlib
import logging
import re
from typing import TYPE_CHECKING

import orjson
from fastapi import Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, ValidationError

from ..errors import ApiError

if TYPE_CHECKING:
    from ..server import Server

log = logging.getLogger("tolktak")

MAX_JSON = 64 << 10


def json_response(data, status: int = 200) -> Response:
    return Response(
        orjson.dumps(data),
        status_code=status,
        media_type="application/json; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


def no_content() -> Response:
    return Response(status_code=204)


def server(request: Request) -> Server:
    return request.app.state.server


class Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


async def read_body(request: Request, limit: int) -> bytes:
    too_large = ApiError(413, "too_large", "Request body is too large")
    with contextlib.suppress(ValueError):
        if int(request.headers.get("content-length", "0")) > limit:
            raise too_large
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise too_large
    return bytes(body)


async def read_json[T: Body](request: Request, model: type[T]) -> T:
    raw = await read_body(request, MAX_JSON)
    try:
        data = orjson.loads(raw)
        if data is None:
            data = {}
        elif isinstance(data, dict):
            # null leaves a field at its default, as an absent field does.
            data = {k: v for k, v in data.items() if v is not None}
        return model.model_validate(data)
    except orjson.JSONDecodeError, ValidationError, TypeError:
        raise ApiError(400, "bad_request", "Malformed request body") from None


def path_id(request: Request, name: str = "id") -> int:
    v = request.path_params.get(name, "")
    if not re.fullmatch(r"\+?[0-9]{1,19}", v) or not 0 < (i := int(v)) < 1 << 63:
        raise ApiError(400, "bad_request", "Invalid ID in path")
    return i


def query_int(request: Request, name: str) -> int:
    v = request.query_params.get(name, "")
    try:
        return int(v) if re.fullmatch(r"[+-]?[0-9]{1,19}", v) else 0
    except ValueError:
        return 0
