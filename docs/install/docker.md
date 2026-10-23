# Install with Docker

Docker Compose runs the TolkTak server and LiveKit for voice, video and screen sharing. This guide assumes a Linux server with Git, Docker and the Compose plugin installed. See [Requirements](requirements.md) for hardware and network ports.

## 1. Deployment files

```sh
git clone https://github.com/D4eNst/tolktak.git
cd tolktak/deploy
```

Run all subsequent commands from the `deploy/` directory.

## 2. Configuration

The `init.sh` script creates `.env` with server parameters and `livekit.yaml` with LiveKit settings. It generates fresh keys when run. These files contain secrets and should not be published.

### Internet server

HTTPS requires [two domain names](../guides/domains.md) pointing to the server: one for TolkTak and one for LiveKit.

```sh
./init.sh talk.example.com lk.example.com
```

Replace the example domains with your own. In this configuration, both services listen on `127.0.0.1`; a [reverse proxy](../guides/reverse-proxy.md) handles HTTPS with [certificates](../guides/certificates.md) for both names. Calls also require open [media ports](../guides/firewall.md).

### Local network server

For a setup without HTTPS, pass the machine's address that participants can reach:

```sh
./init.sh --http 192.168.1.20
```

With this address, TolkTak is available at `http://192.168.1.20:8080` and LiveKit at `ws://192.168.1.20:7880`. Passwords, messages and files are sent over unencrypted HTTP. For an internet server, use the HTTPS setup above.

### Server parameters

The main settings are in `.env`:

| Parameter | Purpose |
|---|---|
| `TOLKTAK_SERVER_NAME` | Server name. |
| `TOLKTAK_REGISTRATION` | Registration mode. The default is `invite`. The first account can be created in any mode. |
| `TOLKTAK_VERSION` | TolkTak image version. The default is `latest`; a specific tag pins the version. |

Other settings are listed in the [configuration reference](../operations/configuration.md). If `.env` already exists, `init.sh` stops rather than overwriting it. Edit existing configuration files directly.

## 3. Start the services

```sh
docker compose up -d
docker compose ps
```

Compose downloads `ghcr.io/d4enst/tolktak-server` with the selected tag and starts both services. To view their logs:

```sh
docker compose logs --tail 100 tolktak livekit
```

## 4. Create the administrator

After starting the server, register at its address, for example `https://talk.example.com` or `http://192.168.1.20:8080`. **The first account becomes the administrator**, so create it straight away.

The administration panel is at `/admin` on the same address. It provides invites for other participants. They register on the server's website and sign in to the [desktop app](desktop-app.md) with the same server address, username and password.

## 5. Check the connection

Use two accounts to check app sign-in, messaging, a call and screen sharing. A participant connecting from another network helps verify media port access: a working chat alone does not confirm it.

For voice and video connection issues, see [Troubleshooting](../operations/troubleshooting.md). After the first launch, set up [backups](../operations/maintenance.md).
