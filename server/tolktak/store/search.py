"""Casefolded literal substring search over database-native trigram indexes."""

from tortoise.exceptions import OperationalError

from .. import db

BACKFILL_BATCH = 100


async def check_features(c: db.BaseDBAsyncClient) -> None:
    if db.is_postgres(c):
        return
    try:
        version = (await db.rows("SELECT sqlite_version() AS version, fts5_source_id() AS fts", c=c))[0]["version"]
    except OperationalError as exc:
        raise RuntimeError("Message search requires SQLite 3.34+ with FTS5 and its trigram tokenizer") from exc
    if tuple(int(part) for part in version.split(".")) < (3, 34, 0):
        raise RuntimeError("Message search requires SQLite 3.34+ with FTS5 and its trigram tokenizer")


async def init_index(tx: db.BaseDBAsyncClient) -> None:
    if db.is_postgres(tx):
        try:
            await tx.execute_query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        except OperationalError as exc:
            raise RuntimeError("Message search requires PostgreSQL pg_trgm; enable it as the database owner") from exc
        await tx.execute_query("CREATE INDEX message_search_trigram ON message_search USING GIN (folded gin_trgm_ops)")
        return
    try:
        await tx.execute_query(
            "CREATE VIRTUAL TABLE message_search_fts USING fts5(folded, content='message_search', "
            "content_rowid='message_id', tokenize='trigram case_sensitive 1')"
        )
    except OperationalError as exc:
        raise RuntimeError("Message search requires SQLite 3.34+ with FTS5 and its trigram tokenizer") from exc
    await tx.execute_query(
        "CREATE TRIGGER message_search_insert AFTER INSERT ON message_search BEGIN "
        "INSERT INTO message_search_fts(rowid, folded) VALUES (new.message_id, new.folded); END"
    )
    await tx.execute_query(
        "CREATE TRIGGER message_search_delete AFTER DELETE ON message_search BEGIN "
        "INSERT INTO message_search_fts(message_search_fts, rowid, folded) "
        "VALUES ('delete', old.message_id, old.folded); END"
    )
    await tx.execute_query(
        "CREATE TRIGGER message_search_update AFTER UPDATE ON message_search BEGIN "
        "INSERT INTO message_search_fts(message_search_fts, rowid, folded) "
        "VALUES ('delete', old.message_id, old.folded); "
        "INSERT INTO message_search_fts(rowid, folded) VALUES (new.message_id, new.folded); END"
    )


_UPSERT = (
    "INSERT INTO message_search (message_id, folded) VALUES (?, ?) "
    "ON CONFLICT (message_id) DO UPDATE SET folded = excluded.folded"
)


async def replace(mid: int, text: str, tx: db.BaseDBAsyncClient) -> None:
    await db.execute(_UPSERT, [mid, text.casefold()], tx)


async def backfill(tx: db.BaseDBAsyncClient) -> None:
    after = 0
    while batch := await db.rows(
        "SELECT id, text FROM messages WHERE id > ? AND deleted = 0 ORDER BY id LIMIT ?",
        [after, BACKFILL_BATCH],
        tx,
    ):
        await tx.execute_many(db.sql(_UPSERT, tx), [[m["id"], m["text"].casefold()] for m in batch])
        after = batch[-1]["id"]
    if db.is_postgres(tx):
        await db.rows("SELECT gin_clean_pending_list('message_search_trigram')", c=tx)
        await tx.execute_query("ANALYZE message_search")


async def candidates(cid: int, query: str, before: int, limit: int, tx: db.BaseDBAsyncClient) -> list[int]:
    folded = query.casefold()
    if not db.is_postgres(tx) and len(folded) >= 3:
        phrase = '"' + folded.replace('"', '""') + '"'
        found = await db.rows(
            "SELECT m.id FROM message_search_fts f JOIN messages m ON m.id = f.rowid "
            "JOIN message_search s ON s.message_id = m.id WHERE message_search_fts MATCH ? "
            "AND f.rowid < ? AND m.channel_id = ? AND m.deleted = 0 AND instr(s.folded, ?) > 0 "
            "ORDER BY f.rowid DESC LIMIT ?",
            [phrase, before, cid, folded, limit],
            tx,
        )
    else:
        contains = "strpos(s.folded, ?)" if db.is_postgres(tx) else "instr(s.folded, ?)"
        indexed = db.is_postgres(tx) and any(
            all(c.isalnum() for c in folded[i : i + 3]) for i in range(len(folded) - 2)
        )
        like = "AND s.folded LIKE ? ESCAPE chr(92) " if indexed else ""
        pattern = "%" + folded.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        found = await db.rows(
            "SELECT m.id FROM messages m JOIN message_search s ON s.message_id = m.id "
            "WHERE m.channel_id = ? AND m.deleted = 0 AND m.id < ? "
            f"{like}AND {contains} > 0 ORDER BY m.id DESC LIMIT ?",
            [cid, before, *([pattern] if indexed else []), folded, limit],
            tx,
        )
    return [m["id"] for m in found]
