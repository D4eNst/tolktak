import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import PlainTextResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import Match, Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__, db, sqlite_backend, web
from .api import auth, chat, files, groups, voice, ws
from .api.common import json_response
from .config import Config
from .errors import ApiError, Conflict, Forbidden, NotFound
from .server import Server
from .store import users

log = logging.getLogger("tolktak")

_API_CORS = [
    (b"access-control-allow-origin", b"*"),
    (b"access-control-allow-headers", b"Authorization, Content-Type"),
    (b"access-control-allow-methods", b"GET, POST, PATCH, DELETE, OPTIONS"),
    (b"access-control-max-age", b"600"),
]
_COMMON = [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer")]
_PAGES = [
    (b"x-frame-options", b"DENY"),
    (
        b"content-security-policy",
        b"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    ),
]


class HeadersMiddleware:
    """CORS can be permissive: authentication is a bearer token, never a cookie."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        api = scope["path"].startswith("/api/")
        extra = _COMMON + (_API_CORS if api else _PAGES)
        if api and scope["method"] == "OPTIONS":
            await send({"type": "http.response.start", "status": 204, "headers": extra})
            await send({"type": "http.response.body", "body": b""})
            return

        started = False
        head = scope["method"] == "HEAD"
        if head:
            # Every GET route also answers HEAD, without a body.
            scope = {**scope, "method": "GET", "head": True}

        async def send_with_headers(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                names = {n for n, _ in extra}
                headers = [(n, v) for n, v in message.get("headers", []) if n.lower() not in names]
                message["headers"] = headers + extra
            elif head and message["type"] == "http.response.body":
                message = {**message, "body": b""}
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        except Exception as e:
            log.error("internal error: %r", e, exc_info=e)
            if started:
                raise
            body = b'{"error":{"code":"internal","message":"Internal server error"}}'
            headers = [(b"content-type", b"application/json; charset=utf-8"), (b"cache-control", b"no-store")]
            await send({"type": "http.response.start", "status": 500, "headers": headers + extra})
            await send({"type": "http.response.body", "body": body})


def create_app(cfg: Config, server: Server | None = None, init_db: bool = True) -> FastAPI:
    srv = server or Server(cfg, __version__)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        users.reset_caches()
        if init_db:
            await db.init(cfg.database_url, cfg.data_dir)
            if await users.count_users() == 0:
                log.info("no accounts yet: the first one to register becomes the administrator")
        tasks = [
            asyncio.create_task(voice.reconcile_loop(srv, 20)),
            asyncio.create_task(_prune_loop(srv)),
            asyncio.create_task(_remove_unused_files_loop(srv)),
        ]
        if srv.updater.enabled:
            tasks.append(asyncio.create_task(srv.updater.run()))
        sqlite_file = db.sqlite_path(cfg.database_url, cfg.data_dir) if init_db else None
        if sqlite_file is not None:
            tasks.append(asyncio.create_task(sqlite_backend.checkpoint_loop(sqlite_file)))
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            for t in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await t
            await srv.lk.close()
            if init_db:
                await db.close()
            if sqlite_file is not None:
                await sqlite_backend.final_checkpoint(sqlite_file)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.server = srv
    for r in (auth.router, chat.router, files.router, groups.router, voice.router, ws.router, web.router):
        app.include_router(r)
    app.mount("/static", web.static_files, name="static")

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        try:
            await db.rows("SELECT 1")
        except Exception as e:
            log.error("health check: database: %r", e)
            return PlainTextResponse("database unavailable\n", status_code=503)
        return PlainTextResponse("ok")

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError) -> Response:
        return json_response({"error": {"code": e.code, "message": e.message}}, e.status)

    @app.exception_handler(NotFound)
    async def not_found(_: Request, e: NotFound) -> Response:
        return json_response({"error": {"code": "not_found", "message": "Not found"}}, 404)

    @app.exception_handler(Forbidden)
    async def forbidden(_: Request, e: Forbidden) -> Response:
        return json_response({"error": {"code": "forbidden", "message": "Access denied"}}, 403)

    @app.exception_handler(Conflict)
    async def conflict(_: Request, e: Conflict) -> Response:
        return json_response({"error": {"code": "conflict", "message": "Conflicts with existing data"}}, 409)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, e: RequestValidationError) -> Response:
        return json_response({"error": {"code": "bad_request", "message": "Malformed request body"}}, 400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, e: StarletteHTTPException) -> Response:
        if e.status_code == 404:
            return PlainTextResponse("404 page not found\n", status_code=404)
        if e.status_code == 405:
            allow = _allowed_methods(app, request.scope)
            return PlainTextResponse("Method Not Allowed\n", status_code=405, headers={"Allow": allow})
        return PlainTextResponse(str(e.detail), status_code=e.status_code, headers=e.headers)

    app.add_middleware(HeadersMiddleware)
    return app


def _allowed_methods(app: FastAPI, scope: Scope) -> str:
    methods: set[str] = set()
    routers = [auth.router, chat.router, files.router, groups.router, voice.router, ws.router, web.router, app.router]
    for route in (r for router in routers for r in router.routes):
        if isinstance(route, Route) and route.methods and route.matches(scope)[0] != Match.NONE:
            methods |= route.methods
    if "GET" in methods:
        methods.add("HEAD")
    return ", ".join(sorted(methods))


async def _prune_loop(srv: Server) -> None:
    while True:
        await asyncio.sleep(600)
        srv.rl.prune()


async def _remove_unused_files_loop(srv: Server) -> None:
    while True:
        try:
            await files.remove_old_unused_files(srv)
        except Exception:
            log.exception("remove unused files")
        await asyncio.sleep(24 * 60 * 60)
