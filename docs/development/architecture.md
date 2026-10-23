# Architecture

This page describes how TolkTak is put together, for people deploying or changing it.

## Components

```
Desktop client (Electron)
 ├─ main process: window, tray, global hotkeys, screen and audio capture, updates
 ├─ preload: a small allow-listed IPC bridge
 └─ renderer: Preact UI, REST and WebSocket client, livekit-client
        │                                        │
        │ HTTPS: REST API                        │ WebRTC media: UDP, TCP or TURN
        │ WSS: event stream                      │ WSS: LiveKit signalling
        ▼                                        ▼
 tolktak-server (Python,      ── join tokens ──▶  LiveKit SFU
  SQLite or PostgreSQL)       ◀── webhooks ──────
```

| Path | Contents |
|---|---|
| `server/` | `tolktak-server`: REST API, WebSocket events, the website (registration, invite management), LiveKit token issuing and webhook handling. Python 3.14 with FastAPI on Uvicorn and Tortoise ORM; SQLite or PostgreSQL. |
| `client/` | The Electron app: `src/main` (main process), `src/preload` (IPC bridge), `src/renderer` (UI, TypeScript and Preact). |
| `client/e2e/` | End-to-end tests against a real LiveKit and server, and Windows capture checks. |
| `deploy/` | Docker Compose deployment with LiveKit, configuration templates and an nginx example. |

### tolktak-server

The server is the source of truth for users, groups, channels, voice rooms, messages and files. It stores everything in one database, with uploaded files in the data directory on disk, and migrates the schema on start. The database is SQLite in WAL mode by default, or PostgreSQL when `TOLKTAK_DATABASE_URL` points to one; both hold the same schema, and `tolktak-server copy-db` copies all data from one to the other.

It runs as a single asyncio process (Uvicorn with uvloop) and is organised in a few modules: `api/` holds the REST and WebSocket handlers, `store/` the database access for users, groups, chat and files, `realtime.py` the hub that fans events out to connected clients, and `livekit.py` the token signing, webhook verification and calls to LiveKit's API. The realtime hub and the rate limits live in memory, so the server is meant to run as one process per database.

Clients talk to it over a REST API under `/api/v1/` and receive changes (new messages, edits, reactions, typing, presence, voice room occupancy, calls) over one WebSocket per client. The server sends an application-level ping every 25 seconds; the client treats 70 seconds of silence as a dead connection and reconnects with exponential backoff, then fetches the messages it missed.

Sending a message is idempotent: each message carries a client-generated nonce, and the server keeps one message per author and nonce, so a retry after a dropped connection does not create a duplicate.

### LiveKit

[LiveKit](https://livekit.io) is a selective forwarding unit (SFU): it receives each participant's audio and video once and forwards it to the others without mixing or transcoding. It knows nothing about users or groups. Every group voice room and every direct-message call maps to one LiveKit room.

LiveKit reports participants joining and leaving through webhooks, which the server uses to show who is in which room. Every 20 seconds the server also lists the participants of active rooms through the LiveKit API, so a lost webhook does not leave stale state.

## Media path

1. The client asks the server to join a room. The server checks that the user is a member of the group (or of the direct-message channel) and returns a LiveKit access token for that room, valid for 12 hours.
2. The client connects to LiveKit with that token and publishes its microphone, camera and screen share.
3. LiveKit forwards the tracks to the other participants over DTLS-SRTP. When UDP is blocked, media goes over TCP or through LiveKit's built-in TURN server.

**Voice.** Microphone audio passes through a processing chain in an AudioWorklet before it is sent: optional neural noise suppression (RNNoise, GTCRN or DeepFilterNet3, compiled to WebAssembly), then a high-pass filter, a voice leveller, a compressor, a look-ahead limiter and a gate for voice activity or push-to-talk. All of it runs locally on the CPU. DeepFilterNet only recognises speech at normal recording levels, so its input is raised towards about -24 dBFS and its output lowered by the same amount. Voice is sent as Opus with DTX and RED.

**Speaking indicator.** Each client measures levels itself 20 times a second: remote voices from the decoded audio, its own voice from the output of the processing chain. The ring turns on at once and off after 450 ms below the threshold. LiveKit's active-speaker events are smoothed on the server and arrive late, so they are only a fallback.

**Video and screen sharing.** Camera and screen tracks are published with simulcast, so LiveKit can send a lower layer to viewers on slow connections instead of slowing everyone down. H.264 is used when the system can encode it, VP8 otherwise, with no second backup codec. A screen share has its full layer and one layer of exactly half its size, so that both stay on the hardware encoder (Chromium encodes odd sizes and anything below 360p in software). "Source" quality, and sources too small for a half-size layer of at least 360p, go out as a single layer. The client chooses what it receives itself rather than from the size of the video element. The watched stream gets the full layer, and previews of other streams get the 360p layer. While the window is in the background, behind a game, previews and cameras are not received and the interface does not animate. This can be turned off in the settings. Screen sharing has two modes: one keeps the frame rate and lowers resolution under pressure (video and games), the other keeps resolution and lowers frame rate (text and code).

**Screen sharing audio.** On Windows 11 the client uses WASAPI process loopback:

- when sharing a window, it finds the process that owns the window and captures only that process tree's audio;
- when sharing a whole screen, it captures all system audio except TolkTak's own process tree, so the other participants' voices are not sent back to them.

On older Windows versions only full system loopback is available, which includes the voices of the room; the app warns about this before sharing. macOS and Linux share video without audio. Stream audio is sent as stereo Opus at up to 160 kbit/s without voice processing, DTX or RED, and only viewers who opened the stream subscribe to it.

## Security model

The server is designed to be run by people who trust its operator. The operator can read everything stored on it.

**What is and is not encrypted.** Client-server traffic is protected by TLS on your reverse proxy (plain HTTP when the server runs without a certificate), media by DTLS-SRTP between each client and LiveKit. There is no end-to-end encryption: LiveKit handles decrypted media, and messages and files are stored unencrypted in the data directory.

**Accounts.** Passwords are hashed with Argon2id (3 iterations, 64 MB, 2 threads). Login returns a random 256-bit bearer token; the database stores only its SHA-256 hash. A session lasts until the user logs out. The WebSocket connection authenticates with the token in its first frame, so tokens do not appear in URLs or proxy logs. The first account on a server becomes the administrator. Depending on `TOLKTAK_REGISTRATION`, new accounts need an invite code created by the administrator; codes have a use limit and an expiry date.

**Rate limits.** The server applies per-key token-bucket limits to registration and login (per client address and, for login, username), password changes, sending messages, reactions and uploads. Behind a reverse proxy, `TOLKTAK_TRUST_PROXY=1` makes it use `X-Forwarded-For` as the client address.

**Access control.** Messages, channels, rooms and voice tokens are only available to members of the group or direct-message channel. LiveKit tokens are scoped to one room. LiveKit webhooks are accepted only with a valid signature from the configured API key and a matching body hash.

**Uploaded files.** Uploads are limited by `TOLKTAK_MAX_UPLOAD_MB` and stored under a random 128-bit identifier, not under their original name. The content type is detected from the file's contents rather than taken from the client. Only common image, audio and video types are served inline; everything else is served as a download with `application/octet-stream`. Every file response carries `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so an uploaded file can never run as a page of the server's origin. File downloads do not require a session: anyone who has a file's URL can fetch it.

**Website.** The pages served by the server use a strict Content Security Policy (`'self'` only) and cannot be framed.

**Desktop client.** The renderer runs with `sandbox` and `contextIsolation` enabled and Node.js integration disabled, under a Content Security Policy, and can reach the main process only through an allow-listed bridge. Navigation away from the app is blocked. The session token is encrypted at rest through Electron `safeStorage` (DPAPI on Windows, the Keychain on macOS, the Secret Service keyring on Linux). Where no keyring is available, it is stored in a file readable only by the user. Electron fuses disable `RunAsNode`, `NODE_OPTIONS` and the inspector flags, and enable ASAR integrity validation and loading the app only from the ASAR archive.

**Copy-protected content.** TolkTak does not bypass DRM. Windows that display protected video may be captured as a black image.
