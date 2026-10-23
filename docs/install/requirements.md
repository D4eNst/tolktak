# Requirements

## Server

The Docker setup requires:

- Linux on x86-64 or ARM64;
- Git, Docker Engine and the Compose plugin;
- access to network and firewall settings;
- storage for the database, uploaded files and backups.

The standard setup runs two services: TolkTak and LiveKit. SQLite is included; [PostgreSQL](../guides/postgres.md) can be configured separately.

An [installation from source](source.md) requires Python 3.14, uv and LiveKit Server instead of Docker. That guide covers the versions and installation steps.

## Load

Memory, CPU and bandwidth use depend on concurrent connections and media streams. Minimum CPU and RAM requirements have not been established yet.

LiveKit forwards streams to participants. If five people watch one screen share, the server receives one stream and sends five copies. The server's outbound bandwidth matters when choosing a connection.

## Addresses

| Setup | Addresses and connectivity |
|---|---|
| Internet server with HTTPS | Two host names, a public IP or port forwarding, a reverse proxy and certificates. |
| Local network without HTTPS | An IP address or host name that participants can reach. Each service uses its own port. |

See [Domains and addresses](../guides/domains.md) for setup. In HTTP mode, passwords, messages and files are sent without encryption.

## Ports

Default values from the project's configuration:

| Port | Protocol | Purpose |
|---|---|---|
| 443 | TCP | HTTPS through the reverse proxy |
| 80 | TCP | Certificate validation via HTTP-01, if used |
| 8080, 7880 | TCP | Direct access to TolkTak and LiveKit in HTTP mode |
| 7881 | TCP | Media for connections where UDP is unavailable |
| 50000–60000 | UDP | Voice, video and screen sharing |
| 3478 | UDP | TURN |
| 30000–40000 | UDP | TURN relay |

With HTTPS, ports 8080 and 7880 listen only on `127.0.0.1`. LiveKit media ports need to be opened separately: port 443 alone is not enough for calls. See [Firewall and ports](../guides/firewall.md) for example rules and port changes.

## Desktop app

See the [desktop app guide](desktop-app.md) for supported systems and platform differences. Once the server is ready, follow [Install with Docker](docker.md).
