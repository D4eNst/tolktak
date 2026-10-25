# Install with Docker Compose

This setup is meant for a permanent server: your own domain with HTTPS, PostgreSQL for the database, S3 storage for files and LiveKit in its own container. It is described by one `compose.yaml` file, and each bundled service can be replaced with one you already have. An installer asks which of them you want and writes the settings.

| Service | Image | Role |
|---|---|---|
| `tolktak` | `d4enst/tolktak-server` | The TolkTak server |
| `livekit` | `livekit/livekit-server` | Voice, video and screen sharing |
| `postgres` | `postgres:17` | The database |
| `garage` | `dxflrs/garage` | [Garage](https://garagehq.deuxfleurs.fr/), S3 storage for uploaded files |
| `caddy` | `caddy:2.11` | HTTPS with certificates from Let's Encrypt, obtained and renewed automatically |

You need a Linux server with Docker Engine, the Compose plugin 2.23.1 or later (`docker compose version`) and `openssl`, and a domain name for HTTPS. See [Requirements](requirements.md). To try TolkTak first, a [single `docker run`](docker.md) is enough.

## 1. Domain

Create a DNS record for the name participants will use, pointing to the server's public IP:

| Name | Type | Value |
|---|---|---|
| `chat.example.com` | A | `203.0.113.10` |

One name is enough: LiveKit is reached through the same domain. `dig +short chat.example.com` should return the server's address. See [Domains and addresses](../guides/domains.md) for IPv6 and CDN proxies.

## 2. Install

```sh
mkdir tolktak && cd tolktak
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/install.sh && sh install.sh
```

The installer checks that Docker, Compose and `openssl` are there and downloads `compose.yaml` and `example.env` from the latest release. Then it asks:

| Question | Choices; the first one is the default |
|---|---|
| How people reach the server | A domain with a certificate from Caddy; a domain behind your own reverse proxy; an IP address over plain HTTP |
| Database | PostgreSQL in this setup, with a generated password; your own PostgreSQL; SQLite |
| Uploaded files | Garage in this setup; your own S3 bucket; the server's disk |
| Server name | `TolkTak` |

Press Enter to take the value in brackets. The details of your own PostgreSQL or S3 can be entered right away or later in `.env`. The installer writes `.env` with generated secrets, readable only by its owner, prints the ports to open and offers to start the server. It changes nothing outside the directory and stops if `.env` already exists. You can read `install.sh` before running it.

`.env` holds the secrets: do not publish it, and include it in backups. Every setting can be changed there later; `docker compose up -d` applies the change.

### Without the installer

```sh
mkdir tolktak && cd tolktak
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/D4eNst/tolktak/releases/latest/download/example.env
```

Set your domain in `.env` with `TOLKTAK_DOMAIN=chat.example.com`, then append random passwords and keys, once:

```sh
cat >> .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
GARAGE_ACCESS_KEY=GK$(openssl rand -hex 12)
GARAGE_SECRET_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

The other settings in `.env` are optional; see the [configuration reference](../operations/configuration.md). If a required value is missing, Compose refuses to start and names it.

## 3. Ports

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Certificate issuance and the redirect to HTTPS |
| 443 | TCP and UDP | HTTPS |
| 7881 | TCP | Calls when a participant's network blocks UDP |
| 7882 | UDP | Voice, video and screen sharing |

Open them in the server's firewall and in your hosting provider's firewall. With your own reverse proxy, 80 and 443 are its ports; over plain HTTP, open 8080/TCP and 7880/TCP instead of them. See [Firewall and ports](../guides/firewall.md).

## 4. Start

If the installer has not started the server already:

```sh
docker compose up -d
docker compose ps
```

On the first start, Caddy obtains a certificate for the domain; this takes up to a minute. To follow the logs:

```sh
docker compose logs -f tolktak livekit caddy
```

Open `https://chat.example.com` and register. **The first account becomes the administrator.** Then check a call between two accounts, preferably on different networks: a working chat does not prove that the call ports are open.

## Your own database, storage or proxy

`COMPOSE_PROFILES` in `.env` lists the bundled services that Compose starts:

```sh
COMPOSE_PROFILES=livekit,postgres,garage,caddy
```

To use your own service instead, remove it from the list, set what replaces it in `.env` and run `docker compose up -d`. A bundled service that is already running keeps running; remove it with `docker compose rm -sf garage` (or `livekit`, `postgres`, `caddy`). Its volume stays.

- **PostgreSQL** that you already run, or a managed one: remove `postgres` and set `TOLKTAK_DATABASE_URL`. See [PostgreSQL](../guides/postgres.md).
- **S3** from a provider, such as AWS S3, Cloudflare R2 or Backblaze B2: remove `garage` and set the `TOLKTAK_S3_*` variables. To keep files on the server's disk instead, set an empty `TOLKTAK_S3_BUCKET=`. See [S3 storage](../guides/s3.md).
- **A reverse proxy** that already serves ports 80 and 443, such as nginx: remove `caddy`. TolkTak listens on `127.0.0.1:8080` and LiveKit on `127.0.0.1:7880`. Send the domain to the first and the path `/rtc` to the second, as in [Reverse proxy](../guides/reverse-proxy.md). If port 8080 or 7880 is taken, set `TOLKTAK_PORT` or `LIVEKIT_PORT`.

- **LiveKit** elsewhere, such as LiveKit Cloud: remove `livekit` and set `LIVEKIT_PUBLIC_URL`, `LIVEKIT_INTERNAL_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. See [Configuration](../operations/configuration.md#livekit).

Keep your settings in `.env`: an upgrade replaces `compose.yaml`. For a change that `.env` does not cover, put it in `compose.override.yaml` next to it; Compose merges that file automatically and upgrades leave it alone.

## Moving from docker run

The data of a server started with [`docker run`](docker.md) is in its `tolktak-data` volume: an SQLite database and uploaded files. Move it before anyone registers on the new server, since the database copy needs an empty destination.

```sh
docker stop tolktak
docker compose up -d postgres garage
docker compose run --rm -v tolktak-data:/old tolktak copy-db sqlite:///old/tolktak.db
docker compose run --rm -v tolktak-data:/old -e TOLKTAK_DATA_DIR=/old tolktak copy-files
docker compose up -d
```

`copy-db` copies all accounts, chats and sessions into the server's database, and `copy-files` uploads the files to the S3 bucket. The old volume keeps its files, but `copy-db` first upgrades its database to the server's schema, so an older version no longer starts on it. Remove the volume with `docker volume rm tolktak-data` once the new server works. Users stay signed in, but the server address changes: in the app, they sign out and enter `https://chat.example.com`.

## Upgrade

Read the [release notes](https://github.com/D4eNst/tolktak/releases) and take a [backup](../operations/maintenance.md#backups) first: the database is migrated when the new version starts.

```sh
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/compose.yaml
docker compose pull
docker compose up -d
```

The first command replaces `compose.yaml`, which pins the LiveKit version and other images; your settings stay in `.env` and `compose.override.yaml`. With a pinned `TOLKTAK_VERSION`, change it in `.env` to the new release first.

## Next steps

- [Administration](../operations/administration.md): invites and access.
- [Maintenance](../operations/maintenance.md): backups of the volumes and the database.
- [Troubleshooting](../operations/troubleshooting.md).
