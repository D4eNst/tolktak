# PostgreSQL

TolkTak stores its data in SQLite by default: one file, `tolktak.db`, in the data directory, with nothing else to install. It can use PostgreSQL instead. Uploaded files stay in the data directory either way.

## Which one to use

- **SQLite** is the right choice for a quick start, a test server, or a small server for friends. There is nothing to set up, and a backup is a copy of the data directory.
- **PostgreSQL** is recommended for a main server that many people rely on. It handles many people writing at once better, it can run on another machine or as a managed service, and it comes with its own tools for backups, replication and monitoring.

You can start with SQLite and move later; see [Moving an existing server](#moving-an-existing-server). Databases created by earlier versions of TolkTak open unchanged, and the schema is migrated automatically when the server starts, on both.

The server picks the database from `TOLKTAK_DATABASE_URL` (see [Configuration](../operations/configuration.md)). Empty means SQLite in the data directory; a `postgres://user:password@host:5432/dbname` address means PostgreSQL.

## Option A: PostgreSQL in the same Docker Compose setup

Add a `postgres` service next to TolkTak. Put it in `deploy/docker-compose.override.yml`, which Docker Compose merges into `docker-compose.yml` automatically, so `git pull` does not conflict with your change:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: tolktak
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: tolktak
    ports:
      - 127.0.0.1:5432:5432
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tolktak -d tolktak"]
      interval: 5s
      timeout: 5s
      retries: 10

  tolktak:
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres-data:
```

The TolkTak container uses host networking, so it reaches PostgreSQL at `127.0.0.1:5432`, not by the service name `postgres`. The port is published only on `127.0.0.1`; change the left-hand `5432` if that port is taken on the host.

Generate a password and add both lines to `deploy/.env`:

```sh
openssl rand -hex 24
```

```sh
POSTGRES_PASSWORD=<the generated password>
TOLKTAK_DATABASE_URL=postgres://tolktak:<the generated password>@127.0.0.1:5432/tolktak
```

A hex password needs no escaping in the URL. If you choose your own, percent-encode characters such as `@`, `:`, `/` and `#`.

On a new server, start everything with `docker compose up -d`. On a server that already has data in SQLite, follow [Moving an existing server](#moving-an-existing-server) instead, or the server starts with an empty PostgreSQL database.

## Option B: an existing or managed PostgreSQL

Any PostgreSQL the server can reach works: one already running on the host, on another machine, or a managed service from your provider. Create a user and a database for TolkTak with `psql` as an administrator:

```sql
CREATE USER tolktak WITH PASSWORD 'choose-a-password';
CREATE DATABASE tolktak OWNER tolktak;
```

The server creates its tables on the first start. Set the address in `deploy/.env` (or `/etc/tolktak/.env` for a [source install](../install/source.md)):

```sh
TOLKTAK_DATABASE_URL=postgres://tolktak:choose-a-password@db.example.com:5432/tolktak
```

Restart the server. Its `tolktak-server listening` log line shows `database=postgres` when it uses PostgreSQL.

- If PostgreSQL runs on another machine, allow the TolkTak server in its `pg_hba.conf` and firewall, and nobody else.
- Keep the database close to the server: network latency to the database adds to almost every request.

## Moving an existing server

`tolktak-server copy-db FROM TO` copies all data from one database to another. The destination must be empty; the command refuses to write into a database that already has accounts. Uploaded files stay where they are, in the data directory.

With Docker Compose, after setting up PostgreSQL as in option A or B:

```sh
cd tolktak/deploy
docker compose stop tolktak
docker compose run --rm tolktak copy-db sqlite:///data/tolktak.db \
  postgres://tolktak:<password>@127.0.0.1:5432/tolktak
```

Then make sure `TOLKTAK_DATABASE_URL` is set in `.env` and start the server with `docker compose up -d`. Users stay signed in, since their sessions are copied too.

For a source install:

```sh
sudo systemctl stop tolktak
sudo -u tolktak /opt/tolktak/server/.venv/bin/tolktak-server copy-db \
  sqlite:///var/lib/tolktak/tolktak.db postgres://tolktak:<password>@127.0.0.1:5432/tolktak
```

Add `TOLKTAK_DATABASE_URL` to `/etc/tolktak/.env` and `sudo systemctl start tolktak`.

`copy-db` only reads the data from the SQLite file (after bringing its schema up to date, as the server would on start). Keep the file until you are sure everything works: going back is a matter of removing `TOLKTAK_DATABASE_URL`, though anything written to PostgreSQL in the meantime stays there. The same command copies in the other direction, from PostgreSQL to an empty SQLite file.

## Backups

With PostgreSQL, a backup has two parts: a database dump and the uploaded files in the data directory.

```sh
cd tolktak/deploy
docker compose exec -T postgres pg_dump -U tolktak -Fc tolktak > tolktak-db-$(date +%F).dump
```

`pg_dump` takes a consistent snapshot while the server keeps running. Back up the `files/` folder of the data directory as described in [Maintenance](../operations/maintenance.md#backups); files are never modified after upload, so it can be copied while the server runs. For an external or managed PostgreSQL, run `pg_dump` against it with the same address, or use the provider's backups.

To restore, stop TolkTak and load the dump back:

```sh
docker compose stop tolktak
docker compose exec -T postgres pg_restore -U tolktak -d tolktak --clean --if-exists < tolktak-db-2026-01-31.dump
docker compose start tolktak
```

With SQLite, by comparison, the database is one file in the data directory and is backed up with it.

## Tips

- Pin the major version (`postgres:17`). A new major version cannot open the old data directory; moving to one takes a dump and restore.
- Do not publish PostgreSQL on a public interface. With option A it listens only on `127.0.0.1`.
- Test a restore once, on another machine or into a scratch database. A backup that has never been restored is a guess.
- The rest of the configuration does not change: LiveKit, the reverse proxy and the apps do not know which database the server uses.
