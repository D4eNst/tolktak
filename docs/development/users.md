# Users, contacts and watched profiles

Paths are relative to `/api/v1`. Every registered authenticated user can browse and search **all** registered users and fetch any public profile. Contacts and profile watches do not restrict this access. Contacts require acceptance. Sending a request does not restrict discovery or personal messaging. Blocking is not part of this contract.

`GET /server` advertises `users: 1`, `contacts: 2` and `profile_watch: 1` in `capabilities`.

## Public profiles

A public user contains `id`, `username`, `display_name`, `color`, `is_admin`, `created_at`, `avatar`, `about`, `status` and `profile_revision`. New profile lookup/directory/contact responses also include current `online`, calculated in the API layer from the connection hub. Password hashes, sessions, folded search columns and private contact versions are excluded from public users.

`profile_revision` starts at zero and increases atomically when a visible profile field actually changes. Updating display name and its folded search value shares the revision transaction. An unchanged patch does not advance it. Clients must reject an older profile revision arriving through delayed HTTP, history hydration or `users.snapshot` after a newer `user.updated` event.

Online presence is live connection state and does not advance `profile_revision`. Clients must guard delayed HTTP online values separately against newer presence events. Database profile/contact metadata comes from a consistent snapshot; online is added after that read.

## Directory

```text
GET /users/directory
GET /users/directory?q={literal_query}&after={user_id}&limit=50
GET /users/directory?exclude=1,2,3&limit=50
```

`q` is optional; an empty query browses the catalog. It accepts up to 256 Unicode code points and matches literal substrings of username or display name using Python case folding. Punctuation, `%`, `_`, backslashes and whitespace are literal. No ranking, word tokenization or prefix substitution is applied. Original profile text is unchanged. NUL is rejected because PostgreSQL text cannot store it.

Results are ordered by increasing user ID. `after` is an exclusive numeric boundary, defaults to zero and accepts `0..2^63-1`; it need not identify a current user. `limit` defaults to 50 and accepts `1..100`. The server obtains at most `limit + 1` candidates and hydrates at most `limit` profiles.

`exclude` is an optional comma-separated list of at most 200 distinct positive signed-64-bit IDs. It filters before the page limit, so already selected group members do not consume page capacity. Unknown IDs are valid exclusions. Empty, duplicate, malformed or oversized lists return `400 bad_request`. No users, including self, are excluded by default.

```json
{
  "users": [],
  "contact_ids": [],
  "has_more": false,
  "next_after": null,
  "contacts_version": 0
}
```

`contact_ids` is the subset of **this page's IDs** present in the requester's private contacts. It never returns the complete contact-ID set. `next_after` is the final returned ID when `has_more=true`, otherwise null. Profiles, contact membership and `contacts_version` share one database snapshot. Page boundaries remain numeric ID boundaries across display-name edits; separate pages do not freeze the whole catalog. Filtered query work can scale with the number of users scanned after that boundary, while response memory remains bounded.

Malformed/repeated/unknown parameters, invalid limits and signed/fractional cursor syntax return `400 bad_request`. Authentication is required (`401`).

## Single and batch lookup

```text
GET /users/{id}
POST /users/profiles
{"ids": [1, 2, 3]}
```

Single lookup returns `{user, contact, contacts_version}` and `404` for an unknown/deleted ID. Batch lookup accepts at most 100 JSON integer IDs, deduplicates them and returns `{users, contact_ids, contacts_version}` sorted by user ID. It skips unknown/deleted IDs. Empty batches are valid. Strings, booleans, fractions, zero and values outside positive signed-64-bit range return `400`. Profiles and membership use bounded batch SQL queries rather than one lookup per user.

## Mutual contacts and requests

```text
GET /contacts?relation=contact|incoming|outgoing&q=&after=0&limit=50
GET /contacts/summary
PUT /contacts/{id}
POST /contacts/{id}/accept
POST /contacts/{id}/decline
POST /contacts/{id}/cancel
DELETE /contacts/{id}
```

A relationship is `{state, request_id, since}`. State is `none`, `incoming`, `outgoing` or `contact`. For `none`, both remaining fields are null. Requests and accepted contacts share an opaque UUID for that instance of the relationship; acceptance preserves the UUID. New requests after cancellation, rejection or removal have a different UUID.

`PUT` sends a request and needs no body. Repeating it for outgoing or accepted contact is a no-op. If a request is already incoming, sending returns409 `contact_state`: the user must explicitly accept it. Other actions require `{request_id}` in their JSON body. Only the recipient can accept or decline, only the sender can cancel, and either contact can remove the mutual relationship. A mismatched instance or incompatible state returns409. Accepting an already accepted instance, or repeating cancel/decline/remove after it is gone, is idempotent. Old clicks cannot remove a replacement request or a newly accepted contact.

Each real transition writes both mirrored `contact_links` rows, increments both users' `contacts_version` by exactly1 and computes both incoming counts in one transaction. User rows are locked in increasing ID order. No-op retries do not increment versions or emit events. Self returns400 `bad_contact`; unknown targets404.

The response and each perspective of `contact.changed` contain:

```json
{
  "user_id": 42,
  "contact": false,
  "relation": {"state": "incoming", "request_id": "uuid", "since": 1730600000000},
  "contacts_version": 18,
  "incoming_count": 3
}
```

Events reach every session of the two participants, including watched-profile sessions; unrelated users receive nothing. `incoming_count` means pending incoming requests, not unseen notifications. It is a total over the user's requests, not a count of a loaded page. `GET /contacts/summary` returns `{contacts_version, incoming_count}` and is used after WebSocket hello/reconnect. Events have no durable replay: a version gap or reconnect invalidates partial knowledge and reloads the active list.

List queries default to `relation=contact` and support the directory's literal query, cursor and limit rules. Directory/profile/contact-page responses retain `contact_ids` for accepted contacts and additionally return `relations` (a map of user IDs to non-none relationships) and `incoming_count`. Single-profile lookup returns `contact` plus `relation`. Relationship data belongs to the viewer, never to the shared public profile object. Profile/contact metadata and counters share a read transaction; online presence is added afterwards.

Migration11 creates `contact_links`, keeps the previous one-sided `contacts` table as an unchanged legacy archive, and copies only reciprocal pairs into accepted contacts. It does not expose unilateral entries as requests. Every existing user's contact version advances. The production instance had no contacts at the time of this change. Copydb includes both tables; deleting a user cascades its relationships.

## Dialogs and client lists

`GET /users/dialogs?q=&after=0&limit=50` searches only the authenticated user's existing personal chats. It has the same profile/page shape and literal matching as the directory. Shared group membership alone does not create a dialog. Empty personal chats created by opening a person remain accessible.

The People navigator separates Chats, Contacts, Requests and All. All sends no catalog request for an empty query. Contacts and requests have server filters; dialogs with no query use known channel IDs, while nonempty dialog search is server-backed. Lists load50 results at a time and render a virtual window with TanStack Virtual Core. Only profiles near the visible window are retained; older profiles can be looked up again when scrolling back. A list retains lightweight IDs and ordering snapshots (name, request time and initial presence), not all profile bodies. Evicting a profile must not reorder the list.

Every search field uses one350ms trailing delay, with immediate clearing and Enter, and no search during IME composition. Data hooks do not add another delay. Pending results are not interactive. A shared accent sweep indicates waiting/loading; reduced motion replaces movement with a static indicator. Message search keeps its two-character minimum and its existing page navigation.

New request features require `contacts: 2`; legacy servers do not advertise requests. Deploy the server and client together for the complete workflow.

## Watched WebSocket profiles

The new mode is explicitly selected in authentication:

```json
{"type":"auth","token":"...","profile_scope":"watched"}
```

The `hello` response echoes `profile_scope: "watched"`. Its `online` array contains only self, rather than the server's entire online catalog. Its own profile and authorized voice-room snapshots remain available.

```json
{"type":"users.watch","user_ids":[2,3],"request_id":"optional-client-token"}
```

This replaces the connection's watch list. At most 500 input IDs are accepted; duplicates are deduplicated. Every ID must be a positive signed-64-bit JSON integer. An optional string `request_id` is limited to 64 code points. Invalid frames emit `error` with code `bad_watch` and keep the previous list. An empty list removes all explicit watches; self remains implicitly subscribed.

The server replies with `users.snapshot`:

```json
{"users":[],"user_ids":[2,3],"request_id":"optional-client-token"}
```

`users` contains only existing watched profiles with `profile_revision` and current `online`. Unknown/deleted profiles are skipped, while `user_ids` reports the requested deduplicated list. The request token is echoed when supplied. The server replaces the watch set before its batch database read, then computes current online values and queues the snapshot without an intervening await. Profile revision comparison handles a newer profile update arriving before an older snapshot response.

`user.updated` and `presence` events reach this connection only for watched IDs or self. `user.created` is suppressed in watched mode; new accounts become discoverable by refreshing directory pages. Watches are a resource bound, not a privacy gate: every profile remains available through the authenticated lookup APIs.

Each connection/tab owns an independent list. Disconnect, session revocation and slow-consumer removal clear it. Reconnect starts with no explicit watches; the client must submit its current bounded list again. The ordinary WebSocket frame-size/rate and outgoing queue limits still apply.

## Legacy compatibility and migration

`GET /users` remains the explicit legacy full-directory endpoint. New clients use the paginated routes and bounded lookups instead. WebSocket authentication without `profile_scope` (or with `"all"`) preserves the previous full online hello and global profile/presence events. Unsupported scopes close with code `4002`.

Migration 9 adds private contacts, folded username/display-name values, `contacts_version` and public `profile_revision`. Existing IDs, original profile strings, passwords, sessions, channels, messages, attachments, message-search state and read cursors are preserved. Folded values are backfilled in bounded batches in the same atomic migration; failure leaves schema version 8 intact. `copy-db` preserves all new columns and contact relationships. No authentication, proxy or billing settings are changed.
