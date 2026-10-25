# Configuration

The server is configured with environment variables:

- with [`docker run`](../install/docker.md), as `-e NAME=value` options;
- in the [Compose setup](../install/compose.md), in `.env` next to `compose.yaml`, created from [`example.env`](../../deploy/example.env);
- with a [source install](../install/source.md), in `/etc/tolktak/.env`.

Restart the server after a change. In the Compose setup, `docker compose up -d` recreates the containers whose settings changed; with `docker run`, remove the container and run it again.

## tolktak-server

| Variable | Default | Description |
|---|---|---|
| `TOLKTAK_SERVER_NAME` | `TolkTak` | Name shown in the app and on the website. |
| `TOLKTAK_REGISTRATION` | `invite` | `open`: anyone can register. `invite`: an invite code is required. `closed`: nobody can. The very first account can always register and becomes the administrator. |
| `TOLKTAK_MAX_UPLOAD_MB` | `50` | Maximum size of one uploaded file. Keep the reverse proxy's body limit above it. |
| `TOLKTAK_USER_QUOTA_MB` | `2048` | Total size of the files one user can keep on the server. Files are freed when the messages they were sent in are deleted; files nothing uses, such as replaced pictures, are removed within two days of upload. `0` removes the limit. |
| `TOLKTAK_CLIENT_DOWNLOAD_URL` | empty | Link to the desktop app on the server's website. Empty hides the button. |
| `TOLKTAK_UPDATES` | `manual` | How the server installs new releases. `manual`: when an administrator chooses Update now in Settings → Server. `auto`: by itself, when nobody is in voice and at most a day after the release. `off`: the server does not check for releases. Installing needs the `updater` service of the Compose setup; without it the server only reports new versions. See [Maintenance](maintenance.md#upgrading). |
| `TOLKTAK_LISTEN` | `:8080` | Listen address, `host:port`. |
| `TOLKTAK_DATA_DIR` | `./data` | The SQLite database, uploaded files unless they go to S3, and the generated LiveKit keys. `/data` in the images. |
| `TOLKTAK_DATABASE_URL` | empty | Database to use. Empty: SQLite in `tolktak.db` in the data directory. `postgres://user:password@host:5432/dbname` (or `postgresql://...`) for PostgreSQL, recommended for a main server; `sqlite:///absolute/path.db` for an SQLite file elsewhere. See [PostgreSQL](../guides/postgres.md). |
| `TOLKTAK_S3_BUCKET` | empty | S3 bucket for uploaded files. Empty keeps them in the data directory. See [S3 storage](../guides/s3.md). |
| `TOLKTAK_S3_ENDPOINT` | empty | S3 address of the provider. Empty for AWS S3. |
| `TOLKTAK_S3_REGION` | `us-east-1` | Region of the bucket. |
| `TOLKTAK_S3_ACCESS_KEY`, `TOLKTAK_S3_SECRET_KEY` | empty | Access key for the bucket. Required when `TOLKTAK_S3_BUCKET` is set. |
| `TOLKTAK_TRUST_PROXY` | off | `1` when the server is reachable only through your reverse proxy. Rate limits then use the last address in `X-Forwarded-For`, the one your proxy adds, and LiveKit's address is built from `X-Forwarded-Proto` and `X-Forwarded-Host`. Enable only behind a proxy, or clients can spoof their address. |
| `TOLKTAK_DEBUG` | off | `1` enables debug logging. |

The server refuses to start, with a clear message, if a required variable is missing or a value is invalid.

## LiveKit

| Variable | Default | Description |
|---|---|---|
| `TOLKTAK_EMBEDDED_LIVEKIT` | off; `1` in `d4enst/tolktak` | `1` makes the server start `livekit-server` itself, with keys generated on the first start and kept in `livekit-keys` in the data directory. `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `LIVEKIT_INTERNAL_URL` are then not used. |
| `LIVEKIT_PUBLIC_URL` | empty | Address the apps use to reach LiveKit. Empty: the server derives it from the address the app used, `wss://<domain>` over HTTPS or `ws://<host>:7880` over HTTP. Set it when LiveKit has its own address, for example `wss://lk.example.com`. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required without the embedded LiveKit | Must match the keys in LiveKit's configuration. The secret must be at least 32 characters. |
| `LIVEKIT_INTERNAL_URL` | `http://127.0.0.1:7880` | Address the server uses for LiveKit's API. `http://livekit:7880` in the Compose setup. |

In the Compose setup, these four variables are set in `.env` like the others; `LIVEKIT_API_KEY` defaults to `tolktak` there.

The embedded LiveKit also reads LiveKit's own variables from the server's environment. The one most often needed is `NODE_IP`, the address LiveKit gives to the apps for calls. By default LiveKit discovers the public address through STUN; set `NODE_IP` for a server that participants reach through a local network, which turns the discovery off.

The embedded LiveKit listens on TCP 7880 (signalling), TCP 7881 and UDP 7882 (calls), has TURN turned off and sends its webhook to the server's `TOLKTAK_LISTEN` port. The `livekit` service of the Compose setup works the same way, with the settings below. Other LiveKit options are described in the [LiveKit configuration reference](https://docs.livekit.io/home/self-hosting/deployment/); to change one, override `LIVEKIT_CONFIG` of the `livekit` service in `compose.override.yaml`.

## Compose setup only

| Variable | Default | Description |
|---|---|---|
| `TOLKTAK_DOMAIN` | required | Domain name of the server. Caddy obtains its certificate. |
| `TOLKTAK_VERSION` | `latest` | Tag of `d4enst/tolktak-server` to run. Pin a release such as `0.2.0` to upgrade only when you choose. |
| `COMPOSE_PROFILES` | `livekit,postgres,garage,caddy,updater` | Bundled services to start. Remove one to use your own, see [Install with Docker Compose](../install/compose.md#your-own-database-storage-or-proxy), or `updater` to update by hand. |
| `TOLKTAK_PORT`, `LIVEKIT_PORT` | `8080`, `7880` | Ports on `127.0.0.1` for your own reverse proxy. |
| `LIVEKIT_TCP_PORT`, `LIVEKIT_UDP_PORT` | `7881`, `7882` | Call ports of the `livekit` service. |
| `LIVEKIT_USE_EXTERNAL_IP`, `LIVEKIT_NODE_IP` | `true`, empty | LiveKit discovers the public address through STUN. On a local network, set `LIVEKIT_USE_EXTERNAL_IP=false` and the server's local address in `LIVEKIT_NODE_IP`. |
| `TOLKTAK_BIND`, `LIVEKIT_BIND` | `127.0.0.1` | Interfaces of the TolkTak and LiveKit signalling ports. `0.0.0.0` serves plain HTTP directly, without a reverse proxy; then also set `TOLKTAK_TRUST_PROXY=0`, which is `1` in this setup. |
| `POSTGRES_PASSWORD`, `LIVEKIT_API_SECRET`, `GARAGE_RPC_SECRET`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY` | required | Secrets, written by the [installer](../install/compose.md#2-install). Changing the PostgreSQL password or the Garage keys later does not change them in the existing volumes. |
