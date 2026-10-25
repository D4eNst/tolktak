# Install with Docker

The `d4enst/tolktak` image contains the TolkTak server and LiveKit for voice, video and screen sharing. One command starts a working server. This guide assumes a Linux server with Docker Engine; see [Requirements](requirements.md) for hardware and ports.

For a permanent server with your own domain, HTTPS, PostgreSQL and S3 storage, see [Install with Docker Compose](compose.md).

## 1. Try it

```sh
docker run --network host d4enst/tolktak
```

The server is ready when the log shows `tolktak-server listening`. Open `http://<server address>:8080` in a browser, for example `http://203.0.113.10:8080`, and register. **The first account becomes the administrator.**

In the [desktop app](desktop-app.md), type the same address in full, with `http://` and the port. Without a scheme, the app assumes `https://`.

What this command sets up:

- `--network host` runs the container in the server's own network. LiveKit sees the server's real address, so calls work without further settings. Host networking is fully supported on Linux only.
- The database is SQLite. The database, uploaded files and the LiveKit keys generated on the first start are kept in `/data` inside the container.
- The server uses plain HTTP: passwords, messages and files cross the network unencrypted, and the log warns about it. This is fine for a trial or a local network. For the internet, use HTTPS as described [below](#4-settings) or in [Install with Docker Compose](compose.md).

The command runs in the foreground; Ctrl+C stops the server.

## 2. Keep it running

```sh
docker run -d --name tolktak --restart unless-stopped --network host \
  -v tolktak-data:/data d4enst/tolktak
```

| Option | Purpose |
|---|---|
| `-d` | Runs the server in the background. |
| `--name tolktak` | A fixed name for `docker logs tolktak`, `docker stop tolktak` and the upgrade commands. |
| `--restart unless-stopped` | Starts the server again after a reboot or a crash. |
| `-v tolktak-data:/data` | Keeps the data in the `tolktak-data` volume. Without it, Docker creates an anonymous volume that a new container does not reuse. |

To follow the logs: `docker logs -f tolktak`.

## 3. Open the ports

| Port | Protocol | Purpose |
|---|---|---|
| 8080 | TCP | TolkTak: the website, the API and chat |
| 7880 | TCP | LiveKit: joining a call |
| 7881 | TCP | Calls when a participant's network blocks UDP |
| 7882 | UDP | Voice, video and screen sharing |

With `ufw`:

```sh
sudo ufw allow 8080/tcp
sudo ufw allow 7880:7881/tcp
sudo ufw allow 7882/udp
```

Open the same ports in your hosting provider's firewall, if it has one. A working chat does not prove that calls work: check a call with a participant on another network. See [Firewall and ports](../guides/firewall.md).

## 4. Settings

The server is configured with `-e` options. For example, a server name, open registration and a different port when 8080 is taken:

```sh
docker run -d --name tolktak --restart unless-stopped --network host -v tolktak-data:/data \
  -e TOLKTAK_SERVER_NAME="Our server" -e TOLKTAK_REGISTRATION=open -e TOLKTAK_LISTEN=:18480 \
  d4enst/tolktak
```

To change a setting, remove the container and start it again with the new options. The data stays in the volume:

```sh
docker rm -f tolktak
```

All settings are listed in the [configuration reference](../operations/configuration.md). Some apply to this image in particular:

- **Server on a home or office network.** LiveKit finds the server's public address through STUN. If participants reach the server by its local address, pass that address: `-e NODE_IP=192.168.1.20`.
- **HTTPS.** Put a [reverse proxy](../guides/reverse-proxy.md) in front of the server and add `-e TOLKTAK_TRUST_PROXY=1 -e TOLKTAK_LISTEN=127.0.0.1:8080`. The proxy sends the domain to port 8080 and the path `/rtc` to port 7880. Close ports 8080 and 7880 in the firewall; 7881 and 7882 stay open.
- **LiveKit's ports** 7880, 7881 and 7882 are fixed in this image. If they are taken on the server, use [Docker Compose](compose.md), where LiveKit runs in its own container.

## 5. Upgrade

Read the [release notes](https://github.com/D4eNst/tolktak/releases) and take a [backup](../operations/maintenance.md#backups) first: the database is migrated when the new version starts, and an older version cannot open it afterwards.

```sh
docker pull d4enst/tolktak
docker rm -f tolktak
docker run -d --name tolktak --restart unless-stopped --network host -v tolktak-data:/data d4enst/tolktak
```

Add the same `-e` options you used before. `d4enst/tolktak` without a tag means `latest`, the newest stable release. A tag such as `d4enst/tolktak:0.2.0` or `d4enst/tolktak:0.2` pins the version, so the server is upgraded only when you change the tag.

The same images are published as `ghcr.io/d4enst/tolktak`.

## Next steps

- [Administration](../operations/administration.md): invites and access.
- [Install with Docker Compose](compose.md): your own domain with HTTPS, PostgreSQL and S3. The data of this server can be [moved there](compose.md#moving-from-docker-run).
- [Troubleshooting](../operations/troubleshooting.md).
