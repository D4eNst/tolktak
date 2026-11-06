"""Run against a fresh disposable database: uv run python tests/bench_message_search.py [--database-url URL]."""

import argparse
import asyncio
import json
import random
import statistics
import string
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from tortoise.transactions import in_transaction

from tolktak import db
from tolktak.models import Channel, ChannelMember, Message, User
from tolktak.store import chat, search

PHRASES = [
    "Привет! Подключил новый клиент, звук работает. Давай проверим встречу сегодня вечером.",
    "Спасибо за сообщение. Обновление готово, осталось проверить картинки и поиск по истории.",
    "The latest build is ready. Please check the reconnect flow and leave a note in this channel.",
    "В конфиге server.port=8030; retry_count += 1; путь /api/v1/messages; сохранить literal%_marker.",
    "Нашёл причину ошибки: соединение прервалось, сообщение отправилось повторно. Сейчас всё хорошо.",
    "Meeting notes: reconnect, keyboard navigation, screenshots, attachments, and project settings.",
]


def corpus_text(i: int) -> str:
    base = f"{PHRASES[i % len(PHRASES)]} [{i:06x}]"
    if i % 100 == 0:
        return ((base + " Обсуждаем детали и проверяем изменения.") * 28)[:4000]
    if i % 10 == 0:
        return (base + " Детали позже.") * 4
    return base


async def sizes() -> dict:
    if db.is_postgres():
        found = await db.rows(
            "SELECT relname, pg_total_relation_size(oid) AS bytes FROM pg_class "
            "WHERE relname IN ('messages', 'message_search')"
        )
        return {r["relname"]: r["bytes"] for r in found}
    pages = (await db.rows("PRAGMA page_count"))[0]["page_count"]
    page_size = (await db.rows("PRAGMA page_size"))[0]["page_size"]
    return {"database": pages * page_size}


async def sample_writes(text: str, indexed: bool, count: int = 20) -> dict:
    original = search.replace

    async def noop(mid: int, text: str, tx: db.BaseDBAsyncClient) -> None:
        pass

    samples, edits, deletions, ids = [], [], [], []
    try:
        with patch.object(search, "replace", original if indexed else noop):
            for i in range(count):
                start = time.perf_counter()
                m, _ = await chat.create_message(1, 1, f"write-{indexed}-{len(text)}-{i}", text, 0, [])
                samples.append((time.perf_counter() - start) * 1000)
                ids.append(m["id"])
            for mid in ids:
                start = time.perf_counter()
                await chat.edit_message(mid, 1, text + "!")
                edits.append((time.perf_counter() - start) * 1000)
                start = time.perf_counter()
                await chat.delete_message(mid, 1)
                deletions.append((time.perf_counter() - start) * 1000)
    finally:
        await Message.filter(id__in=ids).delete()
    return {
        "median_ms": round(statistics.median(samples), 3),
        "max_ms": round(max(samples), 3),
        "edit_median_ms": round(statistics.median(edits), 3),
        "delete_median_ms": round(statistics.median(deletions), 3),
    }


async def run(url: str, directory: Path, count: int) -> dict:
    await db.init(url, directory)
    try:
        if await User.all().count():
            raise RuntimeError("Benchmark requires a fresh, empty disposable database")
        for i in (1, 2):
            await User.create(
                id=i,
                username=f"bench{i}",
                display_name=f"Bench {i}",
                password_hash="unused",
                color="#000000",
                created_at=0,
            )
        await Channel.create(id=1, kind="dm", dm_key="1:2", created_at=0)
        await ChannelMember.bulk_create([ChannelMember(channel_id=1, user_id=i) for i in (1, 2)])
        start = time.perf_counter()
        lengths = []
        async with in_transaction(db.CONN) as tx:
            for offset in range(0, count, 1000):
                messages = []
                for i in range(offset, min(offset + 1000, count)):
                    text = corpus_text(i)
                    lengths.append(len(text))
                    messages.append(
                        Message(channel_id=1, author_id=1 if i % 3 else 2, nonce=f"seed-{i}", text=text, created_at=i)
                    )
                await Message.bulk_create(messages, using_db=tx)
        seed_seconds = time.perf_counter() - start
        before = await sizes()
        start = time.perf_counter()
        async with in_transaction(db.CONN) as tx:
            await search.backfill(tx)
        build_seconds = time.perf_counter() - start
        await db.conn().execute_query("ANALYZE")
        after = await sizes()
        indexed = (await db.rows("SELECT COUNT(*) AS n FROM message_search"))[0]["n"]
        queries = {}
        for query in ("literal%_marker", "00002a", "сообщение", "ре", "qz"):
            samples = []
            for _ in range(5):
                start = time.perf_counter()
                result = await chat.search_page(1, 2, query, limit=100)
                samples.append((time.perf_counter() - start) * 1000)
            queries[query] = {
                "median_ms": round(statistics.median(samples), 3),
                "max_ms": round(max(samples), 3),
                "returned": len(result["messages"]),
                "has_more": result["has_more"],
            }
        original_rows = db.rows
        captured = []

        async def record(query, values=None, c=None):
            if query.startswith("SELECT m.id"):
                captured.append((query, values))
            return await original_rows(query, values, c)

        with patch.object(db, "rows", record):
            await chat.search_page(1, 2, "00002a", limit=100)
        prefix = "EXPLAIN (FORMAT JSON) " if db.is_postgres() else "EXPLAIN QUERY PLAN "
        candidate_plan = await db.rows(prefix + captured[-1][0], captured[-1][1])
        if db.is_postgres():
            candidate_plan = json.loads(candidate_plan[0]["QUERY PLAN"])
        rng = random.Random(20261102)
        entropy = "".join(rng.choices(string.ascii_letters + string.digits + string.punctuation, k=4096))
        prose = ("Длинное сообщение с кодом server.port=8030 и подробным описанием изменений. " * 60)[:4096]
        writes = {}
        for name, text in (("ordinary", PHRASES[0]), ("prose4096", prose), ("entropy4096", entropy)):
            folded = text.casefold()
            writes[name] = {
                "chars": len(text),
                "postings": len({folded[i : i + 3] for i in range(len(folded) - 2)}),
                "without_index": await sample_writes(text, False),
                "with_index": await sample_writes(text, True),
            }
        return {
            "dialect": "postgres" if db.is_postgres() else "sqlite",
            "messages": count,
            "average_chars": round(statistics.mean(lengths), 1),
            "max_chars": max(lengths),
            "seed_seconds": round(seed_seconds, 3),
            "index_build_seconds": round(build_seconds, 3),
            "indexed": indexed,
            "bytes_before": before,
            "bytes_after": after,
            "queries": queries,
            "writes": writes,
            "candidate_plan": candidate_plan,
        }
    finally:
        await db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default="")
    parser.add_argument("--messages", type=int, default=100_000)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="tolktak-search-bench-") as temporary:
        print(
            json.dumps(
                asyncio.run(run(args.database_url, Path(temporary), args.messages)), ensure_ascii=False, indent=2
            )
        )
