# Voice moderation

Migration 10 adds room call epochs, a room-wide `moderation_version`, and persistent `voice_rules`. SQLite and PostgreSQL preserve existing rooms and data; database copy includes the new fields, policies and identity sequence.

## Admission boundary

All public `/rtc`, `/rtc/v1` and validation requests go to TolkTak. The app verifies the original LiveKit token signature, issuer, expiry, numeric identity and current channel membership, then signs fresh grants from current policy. Original grants, including grants in SFU-refreshed tokens, never authorize reconnect. Only the private SFU receives those fresh grants. Media still goes directly to LiveKit over UDP/TCP.

Admission holds a room mutex until LiveKit has created/resumed the participant and sent its first response. Policy mutations use the same mutex through the SFU operation. An admission cannot apply stale permissions after a successful moderation response. Membership is checked again after the network handshake; group removal also closes connected admission bridges. Persistent policy writes recheck moderator authorization under the same database group lock used for membership and role changes. The service currently runs as one app process; multiple independent API workers are unsupported because admission locks and bridge ownership are process-local.

**Deployment requirement:** LiveKit HTTP/WebSocket signaling and its server API must not be reachable by participants, even at an alternate address. Self-hosted LiveKit does not revoke existing join tokens when permissions change or a participant is removed. Embedded LiveKit binds HTTP 7880 to loopback without changing RTC TCP/UDP bind addresses. Compose publishes only media ports and routes `/rtc*` to the app. Manual installations assert `TOLKTAK_SIGNALING_PRIVATE=1` only after making signaling private. Otherwise `capabilities.moderation` is absent and moderation mutations return 503 `moderation_unavailable`.

When upgrading, change old reverse-proxy `/rtc` → LiveKit routes to the app, remove public HTTP 7880 mappings, and keep media ports open. `LIVEKIT_PUBLIC_URL` is retained but ignored for advertisement. Optional `TOLKTAK_SIGNALING_PUBLIC_URL` is an **app** WebSocket origin; normally request headers determine it. The app removes credentials from access-log query strings, sends upstream credentials in an Authorization header, and never logs token values. The shipped nginx/Caddy templates protect proxy logs too; custom proxies must redact query credentials and Authorization headers.

## HTTP contract

All routes use bearer authentication. Rules are room-scoped. Ordinary group members can read their own permissions; only group owner/moderator can list or change rules. Owners are protected, moderators can affect ordinary members, and owners can affect moderators. Self-targeting returns 400 (`bad_target`); use local call controls.

A permission snapshot is returned directly:

```json
{"room_id":12,"user_id":8,"rules":[],"allowed":{"entry":true,"microphone":true,"camera":true,"screen":true},"moderation_version":5,"call_id":2}
```

`moderation_version` is monotone per room, including successful one-shot off operations. `call_id` is a persistent integer epoch, or null when no call is active. DM joins return the same shape with `room_id:null`, version 0 and all permissions true. `screen` governs both screen video and screen audio.

A rule has `{id,room_id,user_id,source,duration,expires_at,call_id,created_by}`. Sources are `microphone|camera|screen|entry`; durations are `time|call|permanent`. `expires_at` is Unix milliseconds or null. Rule IDs are stable while replacing a source policy.

| Route | Result |
| --- | --- |
| `GET /api/v1/rooms/{rid}/permissions` | Own current permission snapshot, available to any group member. |
| `GET /api/v1/rooms/{rid}/moderation?after=0&limit=100` | Moderator page `{rules,users,has_more,next_after,moderation_version,call_id}`. Ascending exclusive rule ID; default/max limit 100. Strict nonnegative `after`, positive `limit`; unknown/duplicate parameters return 400. Profiles are only those needed by this page. |
| `PUT /api/v1/rooms/{rid}/moderation/{uid}/{source}` | Body `{duration,seconds?}`; returns target snapshot. `time` requires strict integer seconds 1–31536000; other durations reject seconds. `entry` accepts only `call`. |
| `DELETE /api/v1/rooms/{rid}/moderation/{uid}/{source}` | Idempotent clear, including offline targets; returns target snapshot. |
| `POST /api/v1/rooms/{rid}/participants/{uid}/off` | `{source:"microphone|camera|screen"}`; requires an actually published source, removes it in SFU, restores current permission, and returns target snapshot. No persistent rule. Absent track returns 404 `track_not_found`. |
| `POST /api/v1/rooms/{rid}/participants/{uid}/kick` | Creates an entry rule until the current call ends, closes admission bridges and removes the SFU participant. Returns target snapshot. |
| `POST /api/v1/voice/join` | Existing `{url,token,room}` fields plus `permissions`; entry restriction returns 403 `voice_forbidden`. |

The whole call ends only when the SFU reports the room empty and no admitted signaling bridge remains. A target disconnect or advisory HTTP leave does not end it while someone else is present. Call rules survive reconnect and app restart, then clear when that epoch ends. Permanent rules survive call end. A call-duration rule requires an active call (409 otherwise).

Timed rules expire without a client request. Expiry and call end restore SFU permissions and notify clients. Clearing a rule never republishes a device. The client stops capture on one-shot off and kick; unexpected SFU unpublish clears capture intent even if the app event was lost.

Successful mutations require the SFU effect; unavailable SFU returns 503 `voice_unavailable`. Desired persistent policy may already have committed before a failed SFU operation; retry is safe and reconciliation applies it later. GET remains usable during an SFU outage, retaining the last known active call rather than incorrectly ending it.

## Realtime

The room audience and every session of the target receive:

```json
{"type":"voice.moderation","data":{"room_id":12,"user_id":8,"source":"camera","action":"off","permissions":{"room_id":12,"user_id":8,"rules":[],"allowed":{"entry":true,"microphone":true,"camera":true,"screen":true},"moderation_version":6,"call_id":2}}}
```

Actions are `off|set|clear|kick`. Expiry/end-of-call uses `clear` with a full current snapshot. Moderators can invalidate the rule list by room version. On realtime reconnect, clients read their own permissions again; an allowed snapshot does not re-enable capture automatically. A kick clears join intent and suppresses automatic app rejoin.

## Verification

Regression tests cover both databases, migration/restart/copy, role-revocation races, admission serialization, stale grant rewriting, frame forwarding, expiry, whole-call semantics and scoped events. Raw real-SFU smoke passed on the deployment pin **LiveKit 1.13.10**, including reuse of an SFU-refreshed old token, policy rewrite, kick/re-entry denial, offline clear and timed expiry. The same smoke also passed on locally installed 1.13.11. Browser media tests are separate from this protocol proof.

Primary references: [LiveKit token revocation limitations](https://docs.livekit.io/frontends/reference/tokens-grants/), [pinned admission ordering](https://github.com/livekit/livekit/blob/v1.13.10/pkg/service/rtcservice.go), [pinned permission enforcement](https://github.com/livekit/livekit/blob/v1.13.10/pkg/rtc/participant.go), [separate RTC configuration](https://github.com/livekit/livekit/blob/v1.13.10/pkg/rtc/config.go), [Caddy query-log filtering](https://caddyserver.com/docs/caddyfile/directives/log#query).
