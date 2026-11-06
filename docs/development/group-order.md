# Group channel and room order

`capabilities.group_order=1` supports independent ordering of text channels and voice rooms. Existing `position` columns store the order; no new migration is needed.

- `PUT /api/v1/groups/{gid}/channel-order {"ids":[...]}`
- `PUT /api/v1/groups/{gid}/room-order {"ids":[...]}`

Only the owner or a moderator may write. `ids` must contain unique, strict positive integer IDs and exactly the current complete set for that group and resource type. Invalid IDs/duplicates return 400; a foreign, missing or stale set returns 409 without changing any position. Empty lists are valid only for an empty current set. Repeating the same order is idempotent. Text-channel IDs are the actual channel IDs.

Authorization, set comparison and position updates occur in one transaction under the group lock shared with create/delete/member-role changes. Success returns HTTP 204. A changed order sends the group audience `group.updated` in the normal public group shape; an identical order sends no duplicate event. Group lists use `(position,id)` ordering. Concurrent create/delete cannot silently disappear from the submitted order; clients refresh after a conflict.

Tests cover both databases, stale sets, identity validation, idempotency, sorting and PostgreSQL concurrent create/delete/revocation serialization.
