# Getting started

## Desktop app

- [Downloads](https://tolktak.d4enst.ru/en/download/) — builds for Windows, macOS and Linux.
- [Desktop app guide](install/desktop-app.md) — installation, registration, permissions and updates.

## Self-hosting

TolkTak can run on your own hardware or a rented server.

- [Requirements](install/requirements.md)
- [Install with Docker](install/docker.md) — one `docker run` command.
- [Install with Docker Compose](install/compose.md) — your own domain with HTTPS, PostgreSQL and S3.
- [Install from source](install/source.md)

## Configuration and maintenance

- [Configuration](operations/configuration.md) — environment variables and LiveKit settings.
- [PostgreSQL](guides/postgres.md) and [S3 storage](guides/s3.md) — the database and uploaded files.
- [Administration](operations/administration.md) — registration, invites and access.
- [Upgrades and backups](operations/maintenance.md) — saving and restoring data.
- [Troubleshooting](operations/troubleshooting.md) — connections, audio and service logs.

TolkTak is in early development. Back up server data before upgrading. There is no end-to-end encryption yet: the server operator has access to stored messages and files. See the [security model](development/architecture.md#security-model) for details.

## Development

[Architecture](development/architecture.md), [building and testing](development/building.md), [HTTP and WebSocket API](development/api.md). The guides are also available [on the website](https://tolktak.d4enst.ru/en/docs/) and [in Russian](ru/README.md).
