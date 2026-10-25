# Requirements

## Server

- Linux on x86-64 or ARM64;
- Docker Engine, and the Compose plugin 2.23.1 or later for [Install with Docker Compose](compose.md);
- access to network and firewall settings;
- storage for the database, uploaded files and backups.

There are two ways to run TolkTak with Docker:

| Setup | What runs | When to use |
|---|---|---|
| [`docker run`](docker.md) | One container with TolkTak and LiveKit, SQLite and files in a volume, plain HTTP | A trial, a local network, a small server behind your own reverse proxy |
| [Docker Compose](compose.md) | TolkTak, LiveKit, PostgreSQL, Garage S3 storage and Caddy for HTTPS | A permanent server on its own domain |

An [installation from source](source.md) needs Python 3.14, uv and the LiveKit Server binary instead of Docker.

## Load

Memory, CPU and bandwidth use depend on concurrent connections and media streams. Minimum CPU and RAM requirements have not been established yet.

LiveKit forwards streams to participants. If five people watch one screen share, the server receives one stream and sends five copies. The server's outbound bandwidth matters when choosing a connection.

## Addresses

| Setup | Addresses and connectivity |
|---|---|
| Internet server with HTTPS | One domain name, a public IP or port forwarding, and certificates (Caddy in the Compose setup obtains them automatically). |
| Local network without HTTPS | An IP address or host name that participants can reach. |

See [Domains and addresses](../guides/domains.md) for setup. In HTTP mode, passwords, messages and files are sent without encryption.

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| 80, 443 | TCP | HTTPS and certificate issuance, in the Compose setup or with your own reverse proxy |
| 443 | UDP | HTTP/3, in the Compose setup |
| 8080, 7880 | TCP | TolkTak and LiveKit directly, with `docker run` without HTTPS |
| 7881 | TCP | Calls when UDP is unavailable |
| 7882 | UDP | Voice, video and screen sharing |

Calls need ports 7881 and 7882 in every setup: port 443 alone is not enough. See [Firewall and ports](../guides/firewall.md) for example rules.

## Desktop app

See the [desktop app guide](desktop-app.md) for supported systems and platform differences. Once the server is ready, follow [Install with Docker](docker.md).
