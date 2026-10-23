# Установка из исходников

Этот вариант запускает TolkTak и LiveKit через systemd без Docker. Для обычной установки проще использовать [Docker Compose](docker.md).

## 1. Установите сервер

Нужны Python 3.14 и [uv](https://docs.astral.sh/uv/). Установите uv по его официальной инструкции, затем:

```sh
sudo git clone https://github.com/D4eNst/tolktak.git /opt/tolktak
cd /opt/tolktak/server
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
```

uv создаст `server/.venv`. Если Python скачивается автоматически, `UV_PYTHON_INSTALL_DIR` оставит его в каталоге, доступном служебному пользователю. SQLite используется по умолчанию; [PostgreSQL](../guides/postgres.md) подключается отдельно.

## 2. Установите LiveKit

Скачайте LiveKit Server 1.13 для своей архитектуры из [официальных релизов](https://github.com/livekit/livekit/releases) и установите исполняемый файл `livekit-server` в `/usr/local/bin/`.

## 3. Создайте конфигурацию

```sh
cd /opt/tolktak/deploy
sudo ./init.sh talk.example.com lk.example.com
sudo mkdir -p /etc/tolktak
sudo mv .env livekit.yaml /etc/tolktak/
```

Для локальной сети без HTTPS вместо доменов используйте `sudo ./init.sh --http <адрес>`.

Добавьте в `/etc/tolktak/.env`:

```sh
TOLKTAK_LISTEN=127.0.0.1:8080
TOLKTAK_DATA_DIR=/var/lib/tolktak
LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880
```

При прямом доступе по HTTP нужен `TOLKTAK_LISTEN=0.0.0.0:8080`. В режиме HTTPS настройте [обратный прокси](../guides/reverse-proxy.md).

## 4. Создайте службы

```sh
sudo useradd --system --home /var/lib/tolktak --create-home tolktak
sudo chown root:tolktak /etc/tolktak/.env /etc/tolktak/livekit.yaml
sudo chmod 640 /etc/tolktak/.env /etc/tolktak/livekit.yaml
```

Файл `/etc/systemd/system/tolktak.service`:

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

Файл `/etc/systemd/system/livekit.service`:

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

Откройте [порты](../guides/firewall.md), зарегистрируйте первый аккаунт и создайте приглашения, как при [установке через Docker](docker.md).

## 5. Обновление

Сначала [сохраните данные](../operations/maintenance.md). Затем:

```sh
cd /opt/tolktak/server
sudo git pull
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
sudo systemctl restart tolktak
```

Миграции базы выполняются при старте. Версия сборки из исходников по умолчанию отображается как `0.1.0-dev`; релизная сборка записывает номер в `tolktak/_version.py`.
