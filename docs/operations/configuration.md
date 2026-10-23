# Configuration

The server is configured with environment variables. With Docker Compose they live in `deploy/.env`, which `init.sh` creates from [`.env.example`](../../deploy/.env.example). With a [source install](../install/source.md) they are in `/etc/tolktak/.env`. Restart the server after a change: `docker compose up -d` recreates the container when `.env` changed.

## tolktak-server

| Variable | Default | Description |
|---|---|---|
| `TOLKTAK_SERVER_NAME` | `TolkTak` | Name shown in the app and on the website. |
| `TOLKTAK_REGISTRATION` | `invite` | `open`: anyone can register. `invite`: an invite code is required. `closed`: nobody can. The very first account can always register and becomes the administrator. |
| `TOLKTAK_MAX_UPLOAD_MB` | `50` | Maximum size of one uploaded file. Keep the reverse proxy's body limit above it. |
| `TOLKTAK_CLIENT_DOWNLOAD_URL` | empty | Link to the desktop app on the server's website. Empty hides the button. |
| `LIVEKIT_PUBLIC_URL` | required | `wss://` or `ws://` address the apps use to reach LiveKit. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required | Must match `keys` in `livekit.yaml`. The secret must be at least 32 characters. |
| `LIVEKIT_INTERNAL_URL` | `http://127.0.0.1:7880` | Address the server uses for LiveKit's API. Set by the Compose file. |
| `TOLKTAK_LISTEN` | `:8080` | Listen address. The Compose file builds it from `TOLKTAK_BIND` and `TOLKTAK_PORT`. |
| `TOLKTAK_DATA_DIR` | `./data` | Uploaded files, and the SQLite database when `TOLKTAK_DATABASE_URL` is empty. `/data` in the container. |
| `TOLKTAK_DATABASE_URL` | empty | Database to use. Empty: SQLite in `tolktak.db` in the data directory. `postgres://user:password@host:5432/dbname` (or `postgresql://...`) for PostgreSQL, recommended for a main server; `sqlite:///absolute/path.db` for an SQLite file elsewhere. See [PostgreSQL](../guides/postgres.md). |
| `TOLKTAK_TRUST_PROXY` | off | `1` uses `X-Forwarded-For` as the client address for rate limits. Enable only when the server is reachable exclusively through your proxy, or clients can spoof their address. |
| `TOLKTAK_DEBUG` | off | `1` enables debug logging. |

The server refuses to start, with a clear message, if a required variable is missing or a value is invalid.

## Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `TOLKTAK_VERSION` | `latest` | Tag of `ghcr.io/d4enst/tolktak-server` to run. Pin a release such as `0.1.0` to upgrade only when you choose. |
| `TOLKTAK_BIND`, `LIVEKIT_BIND` | `127.0.0.1` | Interfaces the services listen on. `0.0.0.0` for the layout without a reverse proxy. |
| `TOLKTAK_PORT`, `LIVEKIT_PORT` | `8080`, `7880` | HTTP ports of the two services. |
| `RTC_TCP_PORT`, `RTC_UDP_START`, `RTC_UDP_END` | `7881`, `50000`, `60000` | LiveKit media ports. Also written to `livekit.yaml`. |
| `TURN_UDP_PORT`, `TURN_RELAY_START`, `TURN_RELAY_END` | `3478`, `30000`, `40000` | LiveKit's built-in TURN server. Also written to `livekit.yaml`. |

Port variables are read by `init.sh` when it renders `livekit.yaml`; changing them in `.env` alone does not move LiveKit. See [Firewall and ports](../guides/firewall.md#changing-the-ports).

## livekit.yaml

`init.sh` renders it from [`livekit.yaml.template`](../../deploy/livekit.yaml.template). Settings you may want to change:

- `rtc.use_external_ip` discovers the public address through STUN. Keep it on for servers on the internet.
- `rtc.interfaces` limits which network interfaces LiveKit offers to clients. Useful on hosts with Docker bridges, VPNs or several addresses, where clients otherwise try unreachable candidates first.
- `turn` is LiveKit's built-in TURN over UDP, which helps clients behind strict NAT. TURN over TLS on port 443 would need its own certificate and is not configured.
- `webhook.urls` must point to the server's `/api/v1/livekit/webhook`; it is how the server learns who is in a voice room.

See the [LiveKit configuration reference](https://docs.livekit.io/home/self-hosting/deployment/) for everything else.
