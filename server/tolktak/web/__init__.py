from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).parent / "static"

router = APIRouter()


def _page(name: str):
    async def handler():
        return FileResponse(STATIC / name, media_type="text/html; charset=utf-8")

    return handler


router.add_api_route("/", _page("index.html"), methods=["GET"], include_in_schema=False)
router.add_api_route("/admin", _page("admin.html"), methods=["GET"], include_in_schema=False)
router.add_api_route("/docs", _page("docs.html"), methods=["GET"], include_in_schema=False)

static_files = StaticFiles(directory=STATIC)
