# Maintenance

## Upgrading

**Automatic.** In the Compose setup with the `updater` service, the server installs releases according to `TOLKTAK_UPDATES` (`manual` by default, see [Configuration](configuration.md)). It checks for a new release every hour. In `manual` mode, Settings → Server shows administrators the new version and an Update now button. In `auto` mode, the server downloads the image in advance and restarts when nobody is in voice, at most a day after it saw the release; urgent security releases install at once. Connected users see that the server is updating, and their apps reconnect by themselves. The updater replaces only the server's image and writes the release into `TOLKTAK_VERSION` in `.env`; `compose.yaml`, with LiveKit and the other services, stays as it was, so run the Compose upgrade below now and then. An update only goes forward, so keep [backups](#backups). A server started with `docker run` does not update itself: Settings → Server tells administrators about a new release, and they update with the commands below.

Read the [release notes](https://github.com/D4eNst/tolktak/releases) first. The database schema is migrated automatically when the new version starts; there is no way back to an older version after that except restoring a backup, so take one first.

**`docker run`.** Pull the image and start a new container with the same options, as in [Install with Docker](../install/docker.md#5-upgrade):

```sh
docker pull d4enst/tolktak
docker rm -f tolktak
docker run -d --name tolktak --restart unless-stopped --network host -v tolktak-data:/data d4enst/tolktak
```

**Compose setup.** From the directory with `compose.yaml`:

```sh
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/compose.yaml
docker compose pull
docker compose up -d
```

The new `compose.yaml` brings the tested versions of LiveKit and the other services and replaces the old one; your settings stay in `.env` and `compose.override.yaml`. With a pinned `TOLKTAK_VERSION`, change it in `.env` first.

**Source install.** Check out the new release tag, run `uv sync --no-dev` and restart the service, as in [Install from source](../install/source.md#5-finish).

Users' apps follow the server: they install its version when they start, and offer a restart while they are open. See [the desktop app](../install/desktop-app.md#updates).

## Backups

Everything the server knows is in its database, its uploaded files and its settings.

| Setup | What to back up |
|---|---|
| `docker run` | The `tolktak-data` volume: the SQLite database `tolktak.db`, the `files/` folder and the LiveKit keys. |
| Compose | `.env`; a [database dump](../guides/postgres.md#backups) with PostgreSQL; the files in the `tolktak_garage-data` and `tolktak_garage-meta` volumes; the `tolktak_data` volume when the database is SQLite or the files are kept on disk. |
| Source install | `/var/lib/tolktak` and `/etc/tolktak/.env`. |

`docker volume ls` lists the volumes. The simplest consistent backup of a volume stops the server for a moment. For `docker run`:

```sh
docker stop tolktak
docker run --rm -v tolktak-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tolktak-data-$(date +%F).tar.gz -C /data .
docker start tolktak
```

In the Compose setup, stop the services with `docker compose stop tolktak garage` and archive `tolktak_garage-data` and `tolktak_garage-meta` the same way, then `docker compose start`.

For SQLite backups without stopping, use SQLite's online backup (`sqlite3 tolktak.db ".backup backup.db"`) and copy `files/` afterwards; files are never modified after upload.

**Restore:** stop the server, extract the archives into empty volumes, restore `.env`, and with PostgreSQL restore the database dump. Then start the server.

## Logs and health

```sh
docker logs -f tolktak                       # docker run
docker compose logs -f tolktak livekit       # Compose
curl http://127.0.0.1:8080/healthz           # "ok"
```

For a source install, use `journalctl -u tolktak -f`. Set `TOLKTAK_DEBUG=1` to get more detail while you investigate a problem.

## Moving to another machine

Back up as above, install on the new machine with the same `.env`, restore the volumes, then point DNS at the new address. Users stay signed in, since their sessions are in the database.

## Renewing certificates

In the Compose setup, Caddy renews certificates itself. Otherwise they are renewed by whatever issued them (see [HTTPS certificates](../guides/certificates.md)); reload the reverse proxy after renewal if your certificate client does not do it for you.

## Upgrading from the 0.1 deployment

TolkTak 0.1 was installed from a git checkout with `deploy/init.sh`, `deploy/docker-compose.yml`, `.env`, `livekit.yaml` and a second domain for LiveKit. That layout is gone; the data moves to the [Compose setup](../install/compose.md) with the same commands as from `docker run`.

1. Back up the old `deploy/.env` and the `deploy_tolktak-data` volume, as above.
2. Set up the new directory with the installer, as in [Install with Docker Compose](../install/compose.md#1-domain), steps 1 to 3, with the TolkTak domain you already have. Answer `n` when it offers to start the server. The LiveKit domain is no longer needed: LiveKit is reached through `/rtc` on the same domain.
3. Stop the old services: `docker compose -p deploy down`. It works from any directory, even after `git pull` removed the old `docker-compose.yml`. The volume stays.
4. Move the data as in [Moving from docker run](../install/compose.md#moving-from-docker-run), with `deploy_tolktak-data` instead of `tolktak-data`.
5. Open ports 7881/TCP and 7882/UDP. The old ranges 50000–60000/UDP, 3478/UDP and 30000–40000/UDP can be closed: all calls use port 7882 now, and TURN is off.

The server has new LiveKit keys; the apps get the new LiveKit address from the server and need no changes. If you keep your own nginx instead of Caddy, replace its configuration with the [one-domain example](../guides/reverse-proxy.md#nginx) and remove `caddy` from `COMPOSE_PROFILES`.

To keep SQLite and files on disk instead of moving them, choose SQLite and the server's disk in the installer, and copy the old volume's contents into `tolktak_data` before the first start:

```sh
docker volume create tolktak_data
docker run --rm -v deploy_tolktak-data:/from -v tolktak_data:/to alpine cp -a /from/. /to/
```
