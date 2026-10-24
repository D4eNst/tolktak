# HTTP and WebSocket API

The desktop app uses this API, and so can your own tools and scripts. It is a JSON API under `/api/v1`.

> **Stability.** The API is not versioned beyond `/v1` yet and may change between minor releases while TolkTak is at 0.x. Check the release notes before upgrading a server that your scripts depend on. [`client/src/renderer/api.ts`](../../client/src/renderer/api.ts) is the reference client and always matches the server of the same version.

## Conventions

- Requests and responses are JSON (`Content-Type: application/json`), except file uploads and downloads.
- Timestamps are Unix milliseconds. IDs are integers, except file IDs, which are random strings.
- Errors have an HTTP status and a body of the form `{"error": {"code": "invite_invalid", "message": "Invite code is invalid, expired or used up"}}`. `code` is stable and meant for programs; `message` is English text for people.
- Rate-limited requests get `429` with code `rate_limited`.

## Authentication

```http
POST /api/v1/auth/login
{"username": "alice", "password": "…", "device": "my-script"}
```

returns `{"token": "…", "user": {…}}`. Send the token on every other request:

```http
Authorization: Bearer <token>
```

A token is valid until `POST /api/v1/auth/logout`. `POST /api/v1/auth/register` takes `username`, `display_name`, `password` and, in invite mode, `invite`.

For automation, create a separate account for the script, so its token can be revoked without affecting a person.

## Endpoints

| Method and path | Description |
|---|---|
| `GET /server` | Server name, version, registration mode, LiveKit address. No authentication. |
| `POST /auth/register`, `/auth/login`, `/auth/logout` | Accounts and sessions. |
| `GET /me`, `PATCH /me`, `POST /me/password` | Own profile (`display_name`, `about`, `status`, `avatar`) and password. |
| `GET /users` | All users on the server. |
| `GET /channels` | Channels the user is in: direct messages and group text channels, with the last message and unread count. |
| `POST /dms` | Open a direct-message channel with `user_id`. |
| `GET /channels/{id}/messages` | History. Query: `before`, `after`, `limit`, `q` (search). |
| `POST /channels/{id}/messages` | Send: `text`, `nonce` (client-generated, makes retries safe), optional `reply_to` and `attachments` (file IDs). |
| `POST /channels/{id}/read` | Mark read up to `message_id`. |
| `PATCH /messages/{id}`, `DELETE /messages/{id}` | Edit or delete own message. |
| `POST /messages/{id}/reactions` | Toggle the reaction `emoji`. |
| `POST`, `DELETE /messages/{id}/pin`; `GET /channels/{id}/pins` | Pinned messages. |
| `POST /files?name=…` | Upload; the body is the raw file. Returns `{"file": {"id", …}}`. |
| `GET /files/{id}[/{name}]` | Download. No authentication; see [security model](architecture.md#security-model). |
| `GET /groups`, `POST /groups`, `PATCH`, `DELETE /groups/{id}` | Groups. |
| `POST /groups/{id}/members`, `DELETE /groups/{id}/members/{uid}`, `PUT /groups/{id}/members/{uid}/role` | Membership and roles. |
| `POST /groups/{id}/channels`, `PATCH`, `DELETE /text-channels/{id}` | Text channels. |
| `POST /groups/{id}/rooms`, `PATCH`, `DELETE /rooms/{id}` | Voice rooms. |
| `POST /voice/join`, `POST /voice/leave` | Get a LiveKit URL and token for `room_id` (group room) or `channel_id` (direct call). |
| `POST /calls/{channel}/ring`, `/decline`, `/cancel` | Direct-message calls. |
| `GET`, `POST /admin/invites`, `DELETE /admin/invites/{code}` | Invites. Administrator only. |

Paths in the table are relative to `/api/v1`. `GET /healthz` (outside `/api/v1`) returns `ok` for health checks, or 503 when the database is unavailable.

## Events

Open a WebSocket to `/api/v1/ws` and send the token as the first frame within 10 seconds:

```json
{"type": "auth", "token": "…"}
```

The token is never put in the URL, so it does not end up in proxy logs. The server answers with `hello` (your user, who is online, current voice rooms, server name and version) and then pushes events as `{"type": "…", "data": {…}}`:

| Event | When |
|---|---|
| `message.created`, `message.updated` | A message was sent, edited, deleted, reacted to or pinned. |
| `channel.created`, `channel.deleted`, `channel.read` | Channels appeared or disappeared; read position changed on another device. |
| `group.updated`, `group.deleted` | Group settings, members, rooms or text channels changed. |
| `user.created`, `user.updated`, `presence` | Accounts and online status. |
| `typing` | Someone is typing in a channel. |
| `voice.room` | Who is in a voice room, with mute, deafen, camera and screen flags. |
| `call.ring`, `call.declined`, `call.cancelled`, `call.ended` | Direct-message calls. |
| `ping` | Every 25 seconds. Treat 70 seconds without any frame as a dead connection. |

Events tell you that something changed; after a reconnect, fetch what you missed through REST (`GET /channels`, then `messages?after=…`).

A client can send `{"type": "typing", "channel_id": …}`.

## Voice

`POST /voice/join` returns a LiveKit `url`, `token` and `room`. Connect with any [LiveKit SDK](https://docs.livekit.io/home/client/connect/) to publish or subscribe to audio and video. Tokens are scoped to that one room.

## Bot API (planned)

There is no dedicated bot API yet. Today a script can act as a regular user through the API above. Planned for a later version:

- bot accounts created by the administrator, with tokens that do not expire with a login session and are marked as bots in the app;
- per-bot permissions instead of full user rights;
- outgoing webhooks for events, as an alternative to holding a WebSocket open;
- slash commands registered by bots.

Ideas and use cases are welcome in [issues](https://github.com/D4eNst/tolktak/issues).
