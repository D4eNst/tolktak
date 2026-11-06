# Message history and read state

The server provides bounded history windows for clients that do not keep an entire conversation in memory. This API does not change the existing rule that a current group member can read the group's earlier messages.

All paths below are relative to `/api/v1`. Authentication is required. History and read-state requests return `404` when the user is not a current channel member, without revealing whether the channel or target message exists.

## Capability and compatibility

`GET /server` advertises `"capabilities": {"history": 1, "changes": 1, "search": 1}`. Clients should check the corresponding capability before using history, changes or search.

`GET /channels/{id}/messages` remains available with its existing pagination and search behaviour, including deleted-message records. The new history route excludes those records. Search pagination and the client's bounded cache are separate changes; this API alone does not implement them.

`POST /channels/{id}/read` now returns `200` and the actual read state, rather than an empty `204`. The desktop client's request helper accepts both responses. Additional message, channel and event fields are additive.

## History windows

```text
GET /channels/{id}/history
GET /channels/{id}/history?before={message_id}&limit=50
GET /channels/{id}/history?after={message_id}&limit=50
GET /channels/{id}/history?around={message_id}&limit=100
```

- Without a cursor, the server returns the latest visible messages.
- `before` and `after` are exclusive numeric message-ID boundaries. `after=0` starts at the first visible message; omitting `after` returns the latest window. Gaps and deleted messages do not consume the limit.
- `around` includes the target message and its neighbours directly, without traversing intermediate pages. The target must be a non-deleted message in this channel.
- With `around`, the server initially takes up to `floor((limit - 1) / 2)` earlier messages and fills the remaining slots with later messages. Near either end of the conversation it fills unused slots from the other side.
- Messages are always ordered by ascending ID, regardless of request direction.
- `limit` defaults to `100` and must be between `1` and `100` inclusive.
- Cursor values must be positive signed-64-bit integers, except that `after=0` is valid. Only one of `before`, `after` and `around` may be supplied. Unknown parameters, repeated parameters and malformed values return `400`; they are not silently ignored.

Example response:

```json
{
  "messages": [],
  "users": [],
  "first_id": null,
  "last_id": null,
  "has_before": false,
  "has_after": false,
  "history_version": 0,
  "read": {"message_id": 0, "unread": 0}
}
```

For a non-empty page, `first_id` and `last_id` are the visible boundaries of that page. `has_before` and `has_after` explicitly report whether there are visible messages beyond those boundaries; the number of returned messages is not a substitute for these flags. An exhausted `before` or `after` request can return an empty page while still reporting history in the opposite direction.

Messages include their attachments, reactions, pin state and reply previews. A reply preview includes the target's `revision`, which can advance independently of the reply message's own revision. Deleted reply targets expose neither their previous text nor attachment count. Sending a queued reply to a retained deleted target remains valid. `users` contains the public profiles needed for message authors and reply authors in this window, not the server's full user directory.

The window, its hydrated message data, boundaries, read state and `history_version` are read from a consistent database snapshot. Pagination uses indexed ID boundaries, not `OFFSET`. The returned window is bounded even for a long conversation; computing the unread count can still depend on the amount of unread history.

## Message changes and snapshots

Each channel has a persistent `history_version`. Each message has a `revision`, also included in `message.created` and `message.updated` events.

Sending, editing, deleting, changing reactions or changing pin state advances the channel version and assigns that version to the changed message in the same transaction. Retrying an already accepted send with the same author/nonce does not create another message or advance the version. An unchanged edit or pin request does not advance it either.

Existing messages start with revision `0` when the schema is upgraded. Their IDs, contents, attachments and valid read cursors are preserved. Subsequent changes use the same version scheme as new messages. `GET /channels` includes the current `history_version` for each channel. Its `last_message` is the latest non-deleted message, or null when no visible messages remain.

A snapshot version identifies the message state represented by that response. It does not promise that HTTP responses and WebSocket events arrive in commit order, and it is not a durable replay cursor. A client must not replace a newer message revision with an older one. After a disconnect, a changed channel version allows the client to invalidate or reload a bounded window rather than assume that fetching only newly created IDs also retrieves edits and deletions.

## Bounded latest-state changes

```text
GET /channels/{id}/changes?since={history_version}&limit=100
```

`since` is required and accepts a decimal integer between `0` and `2^63 - 1` inclusive. `limit` defaults to `100`, with a minimum of `1` and maximum of `100`. Signs, fractions, empty values, unknown or repeated parameters return `400 bad_request`. A cursor above the authorized channel's current snapshot head returns `409 conflict`. This can follow a database restore: the desktop client reinitializes its connection and session caches with the existing credentials, preserving saved drafts and unsent messages. Active calls and pending operations are cancelled as during a session change. Unauthorized channels return `404` before comparing the cursor to the head.

```json
{
  "messages": [],
  "users": [],
  "history_version": 0,
  "complete": true,
  "read": {"message_id": 0, "unread": 0}
}
```

The response contains current message states whose `revision > since`, ordered by `(revision, id)`, including textless deletion tombstones. The server detects overflow with `limit + 1` indexed candidates and returns at most `limit` hydrated messages. Needed public message/reply author profiles, read state, messages and channel head all come from one authorized consistent read snapshot. Profiles remain bounded by twice the message limit. Reactor profiles are not included.

This is reconciliation of latest states, not an event log: multiple edits of the same message leave one row, and revisions in returned rows need not be consecutive. Legacy revision-zero messages are obtained through history, not through `changes?since=0`. A change to a reply target advances the target's revision; it does not advance every reply's revision. Clients must reconcile cached previews by the target revision.

`complete=true` certifies the interval `(since, history_version]` for current message states, allowing the client to advance its reconciled channel cursor to the snapshot head. `complete=false` does **not** certify that interval: the client must reload its bounded history windows and related message views. It must not advance a complete-interval cursor to this response's head, nor infer deletion from missing rows. A partial response can still contribute individual message states, subject to revision ordering. The endpoint supplies no page/replay cursor for recovering a partial interval.

Schema migration 7 adds `(channel_id, revision)` without changing message IDs, contents, revisions, attachments or read cursors. Exact unread counts and both SQLite/PostgreSQL remain supported.

Message writes serialize with membership and role revocations inside their database transactions. All group message writes and membership/role/ownership changes lock the group row before any channel row. Authorization is checked after these locks; request-level authorization alone does not permit a late write after a revocation commits. An operation already holding the lock may finish before the waiting revocation.

Missing uploaded attachment IDs return `404 file_missing`, allowing an outbox to upload retained bytes again. Another user's file remains `403 bad_file`; malformed IDs remain `400 bad_file`. Attachment checks and message creation share the same transaction. An accepted nonce retry returns its original message without attempting to reattach files.

## Read state

```text
GET /channels/{id}/read
POST /channels/{id}/read
Content-Type: application/json

{"message_id": 42}
```

Both successful requests return:

```json
{
  "channel_id": 7,
  "message_id": 42,
  "unread": 3,
  "history_version": 18
}
```

The POST body requires a positive signed-64-bit JSON integer. Booleans, strings, fractions, missing values and zero are invalid. The target must belong to this channel. A retained deleted-message record is a valid target: a message can be deleted after a client has observed it.

The read cursor only moves forwards. A stale request returns the actual cursor, not the older requested value. `unread` counts non-deleted messages from other authors after that cursor. Sending a message, including an idempotent retry, does not acknowledge unseen incoming messages.

The same state is sent to the user's connected devices in a `channel.read` event. Reading does not advance `history_version`, which describes changes to messages, not user activity. Clients must therefore also compare read cursors when reconciling read-state responses; a channel version alone cannot order two reads.

Fetching history or search results does not mark them read. Determining which messages were actually visible in the focused, recently active window is the client's responsibility.


## Channel search

```text
GET /channels/{id}/search?q={literal_query}&before={message_id}&limit=50
```

Search is scoped to one currently accessible channel and excludes deleted messages. `q` is required and contains 2–256 Unicode code points before case folding. The API preserves the query exactly, including leading/trailing whitespace, punctuation, code, backslashes, `%` and `_`; it does not interpret a query as words, prefixes, SQL patterns or FTS syntax. NUL is rejected because PostgreSQL text cannot contain it. Unknown/repeated parameters, invalid query lengths and malformed cursors/limits return `400 bad_request`.

`limit` defaults to `50` and accepts `1`–`100`. `before` is an exclusive, positive signed-64-bit message ID. When supplied, it must identify a retained message in this channel, including a deleted or non-matching message; a foreign or unknown cursor returns `404`. Channel membership is checked before cursor lookup, inside the same consistent snapshot as results and profiles.

```json
{
  "messages": [],
  "users": [],
  "has_more": false,
  "next_before": null,
  "history_version": 0
}
```

Results are ordered by descending message ID. The server finds up to `limit + 1` matching IDs to determine `has_more`, then hydrates at most `limit` messages. `next_before` is the last returned ID when `has_more=true`, otherwise null. `users` contains only public message/reply author profiles needed for the page. Attachments, reactions, pin state and reply previews are hydrated in the same snapshot. Search does not compute unread counts or mark anything read.

`history_version` identifies the page snapshot. Pages fetched at different versions may reflect intervening edits/deletions; a cursor is not a token that freezes an entire result set. Clients should invalidate/restart an affected search when reconciling such changes.

The new route applies Python 3.14 `str.casefold()` to both query and a separate stored copy of message text. Thus `STRASSE` matches `Straße`, and Greek sigma variants match consistently on both databases. It does not remove accents or perform Unicode compatibility normalization. Original message text is preserved. The legacy `/messages?q=` route retains its existing request/response behaviour and backend `UPPER` semantics, which can differ between SQLite and PostgreSQL for non-ASCII expansions.

Schema migration 8 creates the separate folded-text table and backfills live messages in bounded ID batches. SQLite uses an external-content FTS5 trigram index with `case_sensitive=1` over the already folded text; safely quoted phrases provide candidates and `instr` checks the exact literal substring. PostgreSQL uses GIN `pg_trgm` over the same folded text, escaped `LIKE` candidates and exact `strpos`. Two-character queries use an indexed channel-ID boundary scan; PostgreSQL also uses that fallback for punctuation-only patterns without indexable alphanumeric trigrams. No matches are silently truncated. Rare absent short queries can therefore scan the channel, while returned/hydrated data remains bounded.

Create/edit/delete updates the message and folded text atomically. SQLite triggers keep the FTS index in the same transaction, including cascade deletions; PostgreSQL maintains GIN automatically. Migration failure rolls back both schema/index creation and its version marker. Existing message IDs, revisions, original contents, attachments, profiles and read cursors remain intact. `copy-db` copies folded rows and lets the destination's native index rebuild through its normal database mechanism.

SQLite requires version 3.34+ with FTS5 and the trigram tokenizer; startup checks report a descriptive error if these are unavailable. The exact Python image pinned by `server/Dockerfile` was verified to provide SQLite 3.46.1 and the FTS5 trigram tokenizer. PostgreSQL requires `pg_trgm`, installed with `CREATE EXTENSION IF NOT EXISTS`; the database owner must enable it or permit its trusted installation. The repository deployment uses official `postgres:17`, whose extension availability was verified. See [SQLite FTS5](https://www.sqlite.org/fts5.html#the_trigram_tokenizer), [PostgreSQL pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html), and [Python casefold](https://docs.python.org/3.14/library/stdtypes.html#str.casefold).

The reproducible local benchmark is `uv run --frozen --python 3.14 python tests/bench_message_search.py` from `server/`; `--database-url` requires a fresh disposable database. Its 100,000-message corpus averages 170.8 characters, with 1% long messages up to 4,000 characters. It also measures 4,096-character repetitive and high-entropy store writes, exceeding the HTTP message limit of 4,000 deliberately. These timings are local evidence, not deployment latency guarantees.

A local macOS/Python 3.14 and isolated PostgreSQL 17 container run measured:

| Measurement | SQLite | PostgreSQL |
| --- | ---: | ---: |
| Build folded text + native index, 100k messages | 4.42 s | 10.06 s |
| Folded text + native index storage | +71.6 MB database growth | 49.4 MB table + indexes |
| Literal/code query, first 100 hits, median | 2.09 ms | 4.51 ms |
| Rare query, one hit, median | 0.63 ms | 3.00 ms |
| Absent two-character query, median | 51.5 ms | 47.8 ms |
| Create 4,096-character high-entropy message, median | 0.90 ms | 3.39 ms |
| Edit that message, median | 1.04 ms | 3.81 ms |

SQLite's complete benchmark database grew from 37.8 MB to 109.4 MB. PostgreSQL's existing `messages` table and indexes remained 46.5 MB; the separate search table/indexes consumed the 49.4 MB shown above. Ordinary 86-character indexed writes measured 0.25 ms and 2.45 ms respectively; container/host noise dominated the PostgreSQL no-index comparison. Natural plans used SQLite's FTS virtual index with row-ID boundary/order and PostgreSQL's `message_search_trigram` bitmap index. The discarded custom posting-table prototype required about 332 MB additional SQLite space and 33 s to build; it is not part of the schema or runtime.

## Pinned collection snapshot

`GET /channels/{id}/pins` returns `{messages, users, history_version}` from one authorized consistent snapshot. It includes at most 50 live pinned messages ordered by `(pinned_at DESC, id DESC)` and only the required message/reply author profiles. Its existing 50-message bound is unchanged; pagination is separate work. Fetching pins does not compute unread counts or acknowledge messages.
