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

Download `livekit-server` 1.13 for your architecture from the [LiveKit releases](https://github.com/livekit/livekit/releases) and install it to `/usr/local/bin/`.

## 3. Generate the configuration

The same `init.sh` as for Docker writes both files. Run it in `deploy/` and move the results:

```sh
cd /opt/tolktak/deploy
sudo ./init.sh talk.example.com lk.example.com     # or: ./init.sh --http 203.0.113.10
sudo mkdir -p /etc/tolktak
sudo mv .env livekit.yaml /etc/tolktak/
```

`.env` does not set the listen address and data directory, which Docker Compose otherwise supplies. Add them to `/etc/tolktak/.env`, using `0.0.0.0:8080` as the listen address if you run without a certificate:

```sh
TOLKTAK_LISTEN=127.0.0.1:8080
TOLKTAK_DATA_DIR=/var/lib/tolktak
LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880
```

## 4. Create the services

```sh
sudo useradd --system --home /var/lib/tolktak --create-home tolktak
sudo chown root:tolktak /etc/tolktak/.env /etc/tolktak/livekit.yaml
sudo chmod 640 /etc/tolktak/.env /etc/tolktak/livekit.yaml
```

`/etc/systemd/system/tolktak.service`:

```ini
[Unit]
Description=TolkTak server
After=network-online.target livekit.service
Wants=network-online.target

[Service]
User=tolktak
WorkingDirectory=/opt/tolktak/server
EnvironmentFile=/etc/tolktak/.env
ExecStart=/opt/tolktak/server/.venv/bin/tolktak-server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/livekit.service`:

```ini
[Unit]
Description=LiveKit media server
After=network-online.target
Wants=network-online.target

[Service]
User=tolktak
ExecStart=/usr/local/bin/livekit-server --config /etc/tolktak/livekit.yaml
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now livekit tolktak
journalctl -u tolktak -f
```

## 5. Finish

With HTTPS, set up the [reverse proxy](../guides/reverse-proxy.md). Then open the server's address and register the administrator account, as described in [Install with Docker](docker.md#4-create-the-administrator).

To upgrade:

```sh
cd /opt/tolktak/server
sudo git checkout tolktak/_version.py      # only if you wrote the version into it
sudo git pull
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
sudo systemctl restart tolktak
```

Database migrations run on start.
