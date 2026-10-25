# Install from source

This runs the server from a checkout under systemd, without Docker. Use it when you want to run a specific commit or cannot use containers.

## 1. Install the server

The server is a Python application. It needs Python 3.14 and [uv](https://docs.astral.sh/uv/), which installs the dependencies and, if the system has no Python 3.14, Python itself.

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh     # or see the uv documentation for other ways
sudo git clone https://github.com/D4eNst/tolktak.git /opt/tolktak
cd /opt/tolktak/server
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
```

This creates a virtual environment in `server/.venv` with the `tolktak-server` command in `server/.venv/bin/`. `UV_PYTHON_INSTALL_DIR` keeps a Python downloaded by uv under `/opt/tolktak`, where the service user can read it, rather than in root's home directory. The website is part of the package. By default the server keeps its data in SQLite; to use PostgreSQL, see [PostgreSQL](../guides/postgres.md).

A source install reports its version as `0.1.0-dev`. To show the real one, write it into `tolktak/_version.py` before starting:

```sh
echo "__version__ = \"$(git describe --tags --always)\"" | sudo tee tolktak/_version.py
```

## 2. Install LiveKit

Download `livekit-server` 1.13 for your architecture from the [LiveKit releases](https://github.com/livekit/livekit/releases) and install it to `/usr/local/bin/`. The server starts it itself, with generated keys, as in the [`docker run` image](docker.md).

## 3. Configuration

```sh
sudo useradd --system --home /var/lib/tolktak --create-home tolktak
sudo mkdir -p /etc/tolktak
sudo install -m 640 -g tolktak /dev/null /etc/tolktak/.env
```

`/etc/tolktak/.env`:

```sh
TOLKTAK_EMBEDDED_LIVEKIT=1
TOLKTAK_DATA_DIR=/var/lib/tolktak
# 127.0.0.1:8080 behind a reverse proxy with HTTPS; 0.0.0.0:8080 to serve plain HTTP directly.
TOLKTAK_LISTEN=127.0.0.1:8080
# 1 behind a reverse proxy: rate limits then use X-Forwarded-For, and LiveKit is reached through /rtc.
TOLKTAK_TRUST_PROXY=1
```

Other settings are listed in the [configuration reference](../operations/configuration.md). LiveKit listens on ports 7880, 7881 and 7882; see [Firewall and ports](../guides/firewall.md).

## 4. Create the service

`/etc/systemd/system/tolktak.service`:

```ini
[Unit]
Description=TolkTak server
After=network-online.target
Wants=network-online.target

[Service]
User=tolktak
WorkingDirectory=/opt/tolktak/server
EnvironmentFile=/etc/tolktak/.env
ExecStart=/opt/tolktak/server/.venv/bin/tolktak-server
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tolktak
journalctl -u tolktak -f
```

The journal holds both the server's and LiveKit's log. If LiveKit stops, the server stops too, and systemd restarts both.

## 5. Finish

With HTTPS, set up the [reverse proxy](../guides/reverse-proxy.md). Then open the server's address and register: **the first account becomes the administrator**.

To upgrade:

```sh
cd /opt/tolktak/server
sudo git checkout tolktak/_version.py      # only if you wrote the version into it
sudo git pull
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
sudo systemctl restart tolktak
```

Database migrations run on start.
