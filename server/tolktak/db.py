import functools
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from tortoise import Tortoise, connections
from tortoise.backends.base.client import BaseDBAsyncClient
from tortoise.backends.base.executor import EXECUTOR_CACHE
from tortoise.transactions import in_transaction

log = logging.getLogger("tolktak")

CONN = "default"

SQLITE = [
    # 1: users, sessions, invites, channels, groups, rooms, messages.
    """
    CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        color         TEXT NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE,
        device     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
    );
    CREATE TABLE invites (
        code       TEXT PRIMARY KEY,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        max_uses   INTEGER NOT NULL,
        uses       INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE channels (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('dm','group')),
        dm_key     TEXT UNIQUE,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE channel_members (
        channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX channel_members_user ON channel_members(user_id);
    CREATE TABLE groups (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        owner_id   INTEGER NOT NULL REFERENCES users(id),
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        created_at INTEGER NOT NULL
    );
    CREATE TABLE group_members (
        group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX group_members_user ON group_members(user_id);
    CREATE TABLE rooms (
        id         INTEGER PRIMARY KEY,
        group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        author_id  INTEGER NOT NULL REFERENCES users(id),
        nonce      TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at  INTEGER,
        deleted    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (author_id, nonce)
    );
    CREATE INDEX messages_channel ON messages(channel_id, id);
    """,
    # 2: profiles, attachments, replies, reactions, pins, group roles and text channels.
    """
    ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT '';
    CREATE TABLE files (
        id          TEXT PRIMARY KEY,
        uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        width       INTEGER NOT NULL DEFAULT 0,
        height      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );
    ALTER TABLE messages ADD COLUMN reply_to INTEGER;
    ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '';
    ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
    CREATE TABLE reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
    );
    ALTER TABLE groups ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    CREATE TABLE text_channels (
        channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX text_channels_group ON text_channels(group_id);
    INSERT INTO text_channels (channel_id, group_id, name, position, created_at)
        SELECT channel_id, id, 'общий', 0, created_at FROM groups;
    """,
]

_ID = "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"

POSTGRES = [
    f"""
    CREATE TABLE users (
        id            {_ID},
        username      TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        color         TEXT NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX users_username ON users (lower(username));
    CREATE TABLE sessions (
        id         {_ID},
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BYTEA NOT NULL UNIQUE,
        device     TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        last_seen  BIGINT NOT NULL
    );
    CREATE TABLE invites (
        code       TEXT PRIMARY KEY,
        created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        max_uses   INTEGER NOT NULL,
        uses       INTEGER NOT NULL DEFAULT 0,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
    );
    CREATE TABLE channels (
        id         {_ID},
        kind       TEXT NOT NULL CHECK (kind IN ('dm','group')),
        dm_key     TEXT UNIQUE,
        created_at BIGINT NOT NULL
    );
    CREATE TABLE channel_members (
        channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_id BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX channel_members_user ON channel_members(user_id);
    CREATE TABLE groups (
        id         {_ID},
        name       TEXT NOT NULL,
        owner_id   BIGINT NOT NULL REFERENCES users(id),
        channel_id BIGINT NOT NULL REFERENCES channels(id),
        created_at BIGINT NOT NULL
    );
    CREATE TABLE group_members (
        group_id  BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at BIGINT NOT NULL,
        PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX group_members_user ON group_members(user_id);
    CREATE TABLE rooms (
        id         {_ID},
        group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at BIGINT NOT NULL
    );
    CREATE TABLE messages (
        id         {_ID},
        channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        author_id  BIGINT NOT NULL REFERENCES users(id),
        nonce      TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        edited_at  BIGINT,
        deleted    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (author_id, nonce)
    );
    CREATE INDEX messages_channel ON messages(channel_id, id);
    """,
    """
    ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT '';
    CREATE TABLE files (
        id          TEXT PRIMARY KEY,
        uploader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        size        BIGINT NOT NULL,
        width       INTEGER NOT NULL DEFAULT 0,
        height      INTEGER NOT NULL DEFAULT 0,
        created_at  BIGINT NOT NULL
    );
    ALTER TABLE messages ADD COLUMN reply_to BIGINT;
    ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '';
    ALTER TABLE messages ADD COLUMN pinned_at BIGINT;
    CREATE TABLE reactions (
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
    );
    ALTER TABLE groups ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    CREATE TABLE text_channels (
        channel_id BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at BIGINT NOT NULL
    );
    CREATE INDEX text_channels_group ON text_channels(group_id);
    INSERT INTO text_channels (channel_id, group_id, name, position, created_at)
        SELECT channel_id, id, 'общий', 0, created_at FROM groups;
    """,
]

# 3: AUTOINCREMENT, so clients never see a deleted row's id reused.
AUTOINCREMENT_TABLES = ["channels", "groups", "rooms", "messages"]
SQLITE.append("autoincrement")
POSTGRES.append("")

# 4: storage used by each user.
SQLITE.append("CREATE INDEX files_uploader ON files(uploader_id)")
POSTGRES.append("CREATE INDEX files_uploader ON files(uploader_id)")

# 5: attachments in their own table, so the messages that use a file are found by index.
SQLITE.append(
    """
    CREATE TABLE message_files (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_id    TEXT NOT NULL,
        position   INTEGER NOT NULL,
        PRIMARY KEY (message_id, position)
    );
    CREATE INDEX message_files_file ON message_files(file_id);
    INSERT INTO message_files (message_id, file_id, position)
        SELECT m.id, f.value, f.key FROM messages m, json_each('["' || replace(m.attachments, ',', '","') || '"]') f
        WHERE m.attachments != '' AND m.deleted = 0;
    ALTER TABLE messages DROP COLUMN attachments;
    """
)
POSTGRES.append(
    """
    CREATE TABLE message_files (
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_id    TEXT NOT NULL,
        position   INTEGER NOT NULL,
        PRIMARY KEY (message_id, position)
    );
    CREATE INDEX message_files_file ON message_files(file_id);
    INSERT INTO message_files (message_id, file_id, position)
        SELECT m.id, f.file_id, f.n - 1
        FROM messages m, unnest(string_to_array(m.attachments, ',')) WITH ORDINALITY AS f(file_id, n)
        WHERE m.attachments != '' AND m.deleted = 0;
    ALTER TABLE messages DROP COLUMN attachments;
    """
)

# 6: ordered message changes and indexed visible history.
for migrations in (SQLITE, POSTGRES):
    migrations.append("""
        ALTER TABLE channels ADD COLUMN history_version BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
        CREATE INDEX messages_visible_channel ON messages(channel_id, id) WHERE deleted = 0;
        UPDATE channel_members SET last_read_id = COALESCE(
            (SELECT MAX(id) FROM messages WHERE channel_id = channel_members.channel_id
                AND id <= channel_members.last_read_id), 0)
        WHERE last_read_id != 0 AND NOT EXISTS (
            SELECT 1 FROM messages WHERE channel_id = channel_members.channel_id AND id = channel_members.last_read_id);
    """)

# 7: bounded latest-state reconciliation by channel revision.
for migrations in (SQLITE, POSTGRES):
    migrations.append("CREATE INDEX messages_channel_revision ON messages(channel_id, revision)")

# 8: casefolded literal substring search; native indexes are initialized during backfill.
for migrations in (SQLITE, POSTGRES):
    migrations.append("""
        CREATE TABLE message_search (
            message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            folded TEXT NOT NULL
        );
    """)

# 9: private contacts, bounded directory matching and public profile ordering.
for migrations in (SQLITE, POSTGRES):
    migrations.append("""
        ALTER TABLE users ADD COLUMN username_folded TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN display_name_folded TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN contacts_version BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN profile_revision BIGINT NOT NULL DEFAULT 0;
        CREATE TABLE contacts (
            owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            contact_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at BIGINT NOT NULL,
            PRIMARY KEY (owner_id, contact_id),
            CHECK (owner_id != contact_id)
        );
        CREATE INDEX contacts_target ON contacts(contact_id);
    """)

# 10: room-scoped persistent media/entry restrictions and call epochs.
for migrations, identity in ((SQLITE, "INTEGER PRIMARY KEY AUTOINCREMENT"), (POSTGRES, _ID)):
    migrations.append(f"""
        ALTER TABLE rooms ADD COLUMN moderation_version BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE rooms ADD COLUMN call_id BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE rooms ADD COLUMN call_active INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE voice_rules (
            id {identity},
            room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            source TEXT NOT NULL CHECK (source IN ('microphone', 'camera', 'screen', 'entry')),
            duration TEXT NOT NULL CHECK (duration IN ('time', 'call', 'permanent')),
            expires_at BIGINT,
            call_id BIGINT,
            created_by BIGINT NOT NULL,
            UNIQUE (room_id, user_id, source)
        );
        CREATE INDEX voice_rules_expiry ON voice_rules(expires_at);
        CREATE INDEX voice_rules_user ON voice_rules(user_id);
    """)

# 11: mutual relations; contacts stays as a legacy archive.
for migrations in (SQLITE, POSTGRES):
    migrations.append("""
        CREATE TABLE contact_links (
            owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            peer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (state IN ('contact', 'incoming', 'outgoing')),
            since BIGINT NOT NULL,
            request_id TEXT NOT NULL,
            PRIMARY KEY (owner_id, peer_id),
            CHECK (owner_id != peer_id)
        );
        CREATE INDEX contact_links_owner_state_peer ON contact_links(owner_id, state, peer_id);
    """)

assert len(SQLITE) == len(POSTGRES)

# Tables in foreign-key order, for copying between databases.
TABLES = [
    "users", "sessions", "invites", "channels", "channel_members", "groups", "group_members",
    "rooms", "messages", "message_files", "files", "reactions", "text_channels",
    "message_search", "contacts", "voice_rules", "contact_links",
]  # fmt: skip


def sqlite_path(url: str, data_dir: Path) -> Path | None:
    if url.startswith(("postgres://", "postgresql://")):
        return None
    return Path(url.removeprefix("sqlite://")) if url else data_dir / "tolktak.db"


def db_config(url: str, data_dir: Path) -> dict:
    path = sqlite_path(url, data_dir)
    if path is None:
        conn: str | dict = url
    else:
        conn = {
            "engine": "tolktak.sqlite_backend",
            "credentials": {
                "file_path": str(path),
                "journal_mode": "WAL",
                "foreign_keys": "ON",
                "busy_timeout": 5000,
                "synchronous": "NORMAL",
            },
        }
    return {
        "connections": {CONN: conn},
        "apps": {"tolktak": {"models": ["tolktak.models"], "default_connection": CONN}},
    }


def conn() -> BaseDBAsyncClient:
    return connections.get(CONN)


def is_postgres(c: BaseDBAsyncClient | None = None) -> bool:
    return (c or conn()).capabilities.dialect == "postgres"


@asynccontextmanager
async def read_transaction():
    async with in_transaction(CONN) as tx:
        if is_postgres(tx):
            await tx.execute_query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        yield tx


_qmark = re.compile(r"\?")


def sql(query: str, c: BaseDBAsyncClient | None = None) -> str:
    if not is_postgres(c):
        return query
    return _numbered(query)


@functools.lru_cache(maxsize=512)
def _numbered(query: str) -> str:
    n = 0

    def repl(_: re.Match) -> str:
        nonlocal n
        n += 1
        return f"${n}"

    return _qmark.sub(repl, query)


async def rows(query: str, values: list | None = None, c: BaseDBAsyncClient | None = None) -> list[dict]:
    c = c or conn()
    return await c.execute_query_dict(sql(query, c), values or [])


def marks(n: int) -> str:
    return ", ".join("?" * n)


async def execute(query: str, values: list | None = None, c: BaseDBAsyncClient | None = None) -> int:
    c = c or conn()
    n, _ = await c.execute_query(sql(query, c), values or [])
    return n


def _statements(script: str) -> list[str]:
    return [s.strip() for s in script.split(";") if s.strip()]


async def migrate(c: BaseDBAsyncClient | None = None) -> None:
    c = c or conn()
    migrations = POSTGRES if is_postgres(c) else SQLITE
    await c.execute_script("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    found = await c.execute_query_dict("SELECT version FROM schema_version")
    if not found:
        await c.execute_query("INSERT INTO schema_version (version) VALUES (0)")
        version = 0
    else:
        version = found[0]["version"]
    if version > len(migrations):
        raise RuntimeError(f"database schema version {version} is newer than this server ({len(migrations)})")
    for i in range(version, len(migrations)):
        if migrations[i] == "autoincrement":
            await _sqlite_autoincrement(c)
            await c.execute_query("UPDATE schema_version SET version = ?", [i + 1])
            log.info("database migrated to schema %d", i + 1)
            continue
        async with in_transaction(c.connection_name) as tx:
            for stmt in _statements(migrations[i]):
                await tx.execute_query(stmt)
            if i + 1 == 8:
                from .store.search import backfill, init_index

                await init_index(tx)
                await backfill(tx)
            if i + 1 == 9:
                from .store.users import backfill_directory

                await backfill_directory(tx)
            if i + 1 == 11:
                from .store.users import backfill_contact_links

                await backfill_contact_links(tx)
            await tx.execute_query(sql("UPDATE schema_version SET version = ?", tx), [i + 1])
        log.info("database migrated to schema %d", i + 1)


_INTEGER_PK = re.compile(r"\bid(\s+)INTEGER PRIMARY KEY\b(?!\s+AUTOINCREMENT)")


async def _sqlite_autoincrement(c: BaseDBAsyncClient) -> None:
    script = ["PRAGMA foreign_keys=OFF", "BEGIN"]
    for t in AUTOINCREMENT_TABLES:
        found = await c.execute_query_dict(
            "SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL", [t]
        )
        table = next(r["sql"] for r in found if r["type"] == "table")
        if "AUTOINCREMENT" in table.upper():
            continue
        new = _INTEGER_PK.sub(r"id\1INTEGER PRIMARY KEY AUTOINCREMENT", table, count=1)
        new = re.sub(rf"^CREATE TABLE \"?{t}\"?", f"CREATE TABLE {t}__new", new, count=1)
        script += [
            new,
            f"INSERT INTO {t}__new SELECT * FROM {t}",
            f"DROP TABLE {t}",
            f"ALTER TABLE {t}__new RENAME TO {t}",
        ]
        script += [r["sql"] for r in found if r["type"] == "index"]
    script += ["COMMIT", "PRAGMA foreign_keys=ON"]
    await c.execute_script(";\n".join(script) + ";")
    if problems := await c.execute_query_dict("PRAGMA foreign_key_check"):
        raise RuntimeError(f"foreign key check failed after migration: {problems[:5]}")


async def init(url: str, data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    # The lifespan and requests run in different tasks.
    await Tortoise.init(config=db_config(url, data_dir), _enable_global_fallback=True)
    from .store.search import check_features

    await check_features(conn())
    await migrate()


async def close() -> None:
    await Tortoise.close_connections()
    # A later init (tests, copy-db) may use another database.
    await Tortoise._reset_apps()
    EXECUTOR_CACHE.clear()  # keyed by connection name, which stays "default"
