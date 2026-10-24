# syntax=docker/dockerfile:1
FROM python:3.14-slim@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8 AS build
COPY --from=ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY README.md ./
COPY tolktak ./tolktak
ARG VERSION=0.1.0-dev
RUN echo "__version__ = \"${VERSION}\"" > tolktak/_version.py \
 && uv sync --locked --no-dev --no-editable \
 && mkdir -p /out/data

FROM python:3.14-slim@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8
RUN useradd --system --uid 65532 --home-dir /nonexistent --shell /usr/sbin/nologin tolktak
COPY --from=build /app/.venv /app/.venv
# A fresh named volume copies this directory, so the non-root user can write the database.
COPY --from=build --chown=65532:65532 /out/data /data
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 TOLKTAK_DATA_DIR=/data TOLKTAK_LISTEN=:8080
VOLUME ["/data"]
EXPOSE 8080
USER 65532
ENTRYPOINT ["tolktak-server"]
