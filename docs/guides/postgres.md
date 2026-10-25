# PostgreSQL

The [Compose setup](../install/compose.md) runs PostgreSQL next to TolkTak. A [`docker run`](../install/docker.md) server and a [source install](../install/source.md) store their data in SQLite: one file, `tolktak.db`, in the data directory, with nothing else to install. Either can use PostgreSQL instead. Uploaded files are not in the database; see [S3 storage](s3.md).

## Which one to use

- **SQLite** is the right choice for a quick start, a test server, or a small server for friends. There is nothing to set up, and a backup is a copy of the data directory.
- **PostgreSQL** is recommended for a main server that many people rely on. It handles many people writing at once better, it can run on another machine or as a managed service, and it comes with its own tools for backups, replication and monitoring.

You can start with SQLite and move later; see [Moving an existing server](#moving-an-existing-server). Databases created by earlier versions of TolkTak open unchanged, and the schema is migrated automatically when the server starts, on both.

The server picks the database from `TOLKTAK_DATABASE_URL` (see [Configuration](../operations/configuration.md)). Empty means SQLite in the data directory; a `postgres://user:password@host:5432/dbname` address means PostgreSQL. Its `tolktak-server listening` log line shows `database=postgres` or `database=sqlite`.

## PostgreSQL in the Compose setup

The installer configures it: the `postgres` service keeps its data in the `postgres-data` volume, the database and its user are both named `tolktak`, and the password is `POSTGRES_PASSWORD` in `.env`. It is reachable only by the other services of the setup, not from outside.

Pin the major version (`postgres:17` in `compose.yaml`). A new major version cannot open the old data directory; moving to one takes a dump and restore, as in [Backups](#backups).

## An existing or managed PostgreSQL

Any PostgreSQL the server can reach works: one already running on the host, on another machine, or a managed service from your provider. Create a user and a database for TolkTak with `psql` as an administrator:

```sql
CREATE USER tolktak WITH PASSWORD 'choose-a-password';
CREATE DATABASE tolktak OWNER tolktak;
```

The server creates its tables on the first start. Give it the address:

- **Compose:** in `.env`, set `TOLKTAK_DATABASE_URL` and remove `postgres` from `COMPOSE_PROFILES`, then run `docker compose up -d` and `docker compose rm -sf postgres`.
- **`docker run`:** add `-e TOLKTAK_DATABASE_URL=...` to the command.
- **Source install:** add the line to `/etc/tolktak/.env` and restart the service.

```sh
TOLKTAK_DATABASE_URL=postgres://tolktak:choose-a-password@db.example.com:5432/tolktak
```

A password of letters and digits needs no escaping in the URL. Otherwise, percent-encode characters such as `@`, `:`, `/` and `#`.

- If PostgreSQL runs on another machine, allow the TolkTak server in its `pg_hba.conf` and firewall, and nobody else.
- Keep the database close to the server: network latency to the database adds to almost every request.
- A PostgreSQL on the same host is not `127.0.0.1` from inside a container in the Compose setup. Make it listen on the Docker bridge address, or run TolkTak's database in the setup itself.

## Moving an existing server

`tolktak-server copy-db FROM TO` copies all data from one database to another. The destination must be empty; the command refuses to write into a database that already has accounts. Users stay signed in, since their sessions are copied too.

From a `docker run` server to the Compose setup, see [Moving from docker run](../install/compose.md#moving-from-docker-run).

For a source install:

```sh
sudo systemctl stop tolktak
sudo -u tolktak /opt/tolktak/server/.venv/bin/tolktak-server copy-db \
  sqlite:///var/lib/tolktak/tolktak.db postgres://tolktak:<password>@127.0.0.1:5432/tolktak
```

Add `TOLKTAK_DATABASE_URL` to `/etc/tolktak/.env` and `sudo systemctl start tolktak`.

`copy-db` only reads the data from the SQLite file (after bringing its schema up to date, as the server would on start). Keep the file until you are sure everything works: going back is a matter of removing `TOLKTAK_DATABASE_URL`, though anything written to PostgreSQL in the meantime stays there. The same command copies in the other direction, from PostgreSQL to an empty SQLite file.

## Backups

With PostgreSQL, a backup has two parts: a database dump and the uploaded files. In the Compose setup, from the directory with `compose.yaml`:

```sh
docker compose exec -T postgres pg_dump -U tolktak -Fc tolktak > tolktak-db-$(date +%F).dump
```

`pg_dump` takes a consistent snapshot while the server keeps running. Back up the files as described in [Maintenance](../operations/maintenance.md#backups). For an external or managed PostgreSQL, run `pg_dump` against it with the same address, or use the provider's backups.

To restore, stop TolkTak and load the dump back:

```sh
docker compose stop tolktak
docker compose exec -T postgres pg_restore -U tolktak -d tolktak --clean --if-exists < tolktak-db-2026-01-31.dump
docker compose start tolktak
```

Test a restore once, on another machine or into a scratch database. A backup that has never been restored is a guess.
