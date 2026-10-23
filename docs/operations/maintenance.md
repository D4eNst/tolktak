# Maintenance

## Upgrading

Read the [release notes](https://github.com/D4eNst/tolktak/releases) first. The database schema is migrated automatically when the new version starts; there is no way back to an older version after that except restoring a backup, so take one first.

**Docker, prebuilt image.** With `TOLKTAK_VERSION=latest`:

```sh
cd tolktak/deploy
git pull                 # picks up changes to the Compose file and examples
docker compose pull
docker compose up -d
```

With a pinned version, change `TOLKTAK_VERSION` in `.env` to the new release, then run the same commands.

**Docker, built from source.**

```sh
git pull
docker compose up -d --build
```

**Source install.** Pull, run `uv sync --no-dev` and restart the service, as in [Install from source](../install/source.md#5-finish).

**LiveKit** is pinned in `docker-compose.yml`. A new TolkTak release updates the pin when a newer LiveKit is tested; there is no need to update it separately.

Users' apps update themselves from GitHub Releases.

## Backups

Everything the server knows is in its database and its data directory: `tolktak.db` (SQLite, the default) and the `files/` folder with uploads. Back them up together with `deploy/.env` and `deploy/livekit.yaml`. With PostgreSQL, the data directory holds only `files/`; back up the database with `pg_dump` as described in [PostgreSQL](../guides/postgres.md#backups).

The simplest consistent backup stops the server for a moment:

```sh
cd tolktak/deploy
docker compose stop tolktak
docker run --rm -v deploy_tolktak-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tolktak-data-$(date +%F).tar.gz -C /data .
docker compose start tolktak
```

The volume name is `<directory>_tolktak-data`; `docker volume ls` shows it. For a source install, archive `/var/lib/tolktak` the same way.

For SQLite backups without stopping, use SQLite's online backup (`sqlite3 tolktak.db ".backup backup.db"`) and copy `files/` afterwards; files are never modified after upload.

**Restore:** stop the server, extract the archive into an empty volume or data directory, restore `.env` and `livekit.yaml`, start the server. With PostgreSQL, restore the database dump before starting.

## Logs and health

```sh
docker compose logs -f tolktak
docker compose logs -f livekit
curl http://127.0.0.1:8080/healthz      # "ok"
```

For a source install, use `journalctl -u tolktak -f`. Set `TOLKTAK_DEBUG=1` to get more detail while you investigate a problem.

## Moving to another machine

Back up as above, install on the new machine with the same `.env` and `livekit.yaml`, restore the data, then point DNS at the new address. Users stay signed in, since their sessions are in the database.

## Renewing certificates

Certificates are renewed by whatever issued them (see [HTTPS certificates](../guides/certificates.md)). Reload the reverse proxy after renewal if your certificate client does not do it for you.
