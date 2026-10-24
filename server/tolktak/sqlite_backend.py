"""Runs SQLite on the event loop thread: aiosqlite's thread hops cost more than the queries."""

import asyncio
import contextlib
import logging
import sqlite3
from pathlib import Path

from tortoise.backends.sqlite.client import SqliteClient

log = logging.getLogger("tolktak")


class _Cursor:
    def __init__(self, cur: sqlite3.Cursor):
        self._cur = cur

    async def fetchall(self):
        return self._cur.fetchall()

    async def close(self) -> None:
        self._cur.close()


class _Connection:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    @property
    def total_changes(self) -> int:
        return self._conn.total_changes

    async def execute(self, sql: str, parameters=None) -> _Cursor:
        return _Cursor(self._conn.execute(sql, parameters or ()))

    async def execute_fetchall(self, sql: str, parameters=None):
        return self._conn.execute(sql, parameters or ()).fetchall()

    async def execute_insert(self, sql: str, parameters=None):
        cur = self._conn.execute(sql, parameters or ())
        return (cur.lastrowid,)

    async def executemany(self, sql: str, parameters) -> _Cursor:
        return _Cursor(self._conn.executemany(sql, parameters))

    async def executescript(self, sql: str) -> _Cursor:
        return _Cursor(self._conn.executescript(sql))

    async def commit(self) -> None:
        self._conn.commit()

    async def rollback(self) -> None:
        self._conn.rollback()

    async def close(self) -> None:
        self._conn.close()


def _upper(v):
    return v.upper() if isinstance(v, str) else v


class InlineSqliteClient(SqliteClient):
    async def create_connection(self, with_db: bool) -> None:
        if self._connection:
            return
        conn = sqlite3.connect(self.filename, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        for pragma, val in self.pragmas.items():
            conn.execute(f"PRAGMA {pragma}={val}").close()
        # Checkpoints are run by checkpoint_loop, off the event loop.
        conn.execute("PRAGMA wal_autocheckpoint=0").close()
        # Case-insensitive lookups compare UPPER() of both sides, and SQLite's own folds only ASCII.
        conn.create_function("upper", 1, _upper, deterministic=True)
        self._connection = _Connection(conn)  # type: ignore[assignment]
        await self._post_connect()


client_class = InlineSqliteClient


def _checkpoint(path: str) -> None:
    conn = sqlite3.connect(path, timeout=5)
    try:
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchall()
    finally:
        conn.close()


async def checkpoint_loop(path: Path, every: float = 5) -> None:
    while True:
        await asyncio.sleep(every)
        try:
            await asyncio.to_thread(_checkpoint, str(path))
        except sqlite3.Error as e:
            log.warning("sqlite checkpoint: %s", e)


async def final_checkpoint(path: Path) -> None:
    with contextlib.suppress(sqlite3.Error):
        await asyncio.to_thread(_checkpoint, str(path))
