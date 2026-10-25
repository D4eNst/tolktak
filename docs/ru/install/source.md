# Установка из исходников

Этот вариант запускает TolkTak через systemd без Docker. Для обычной установки проще [Docker](docker.md).

## 1. Установите сервер

Нужны Python 3.14 и [uv](https://docs.astral.sh/uv/). Установите uv по его официальной инструкции, затем:

```sh
sudo git clone https://github.com/D4eNst/tolktak.git /opt/tolktak
cd /opt/tolktak/server
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
```

uv создаст `server/.venv`. Если Python скачивается автоматически, `UV_PYTHON_INSTALL_DIR` оставит его в каталоге, доступном служебному пользователю. SQLite используется по умолчанию; [PostgreSQL](../guides/postgres.md) подключается отдельно.

## 2. Установите LiveKit

Скачайте LiveKit Server 1.13 для своей архитектуры из [официальных релизов](https://github.com/livekit/livekit/releases) и установите исполняемый файл `livekit-server` в `/usr/local/bin/`. Сервер запускает его сам и сам создаёт ключи, как в [образе для `docker run`](docker.md).

## 3. Создайте конфигурацию

```sh
sudo useradd --system --home /var/lib/tolktak --create-home tolktak
sudo mkdir -p /etc/tolktak
sudo install -m 640 -g tolktak /dev/null /etc/tolktak/.env
```

Файл `/etc/tolktak/.env`:

```sh
TOLKTAK_EMBEDDED_LIVEKIT=1
TOLKTAK_DATA_DIR=/var/lib/tolktak
# 127.0.0.1:8080 за обратным прокси с HTTPS; 0.0.0.0:8080 для прямого доступа по HTTP.
TOLKTAK_LISTEN=127.0.0.1:8080
# 1 за обратным прокси: лимиты запросов берут адрес из X-Forwarded-For, а LiveKit доступен через /rtc.
TOLKTAK_TRUST_PROXY=1
```

Остальные параметры описаны в [справочнике конфигурации](../operations/configuration.md). LiveKit слушает порты 7880, 7881 и 7882; см. [инструкцию по портам](../guides/firewall.md).

## 4. Создайте службу

Файл `/etc/systemd/system/tolktak.service`:

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

В журнале видны и сервер, и LiveKit. Если LiveKit останавливается, сервер останавливается вместе с ним, и systemd перезапускает оба.

С HTTPS настройте [обратный прокси](../guides/reverse-proxy.md). Откройте [порты](../guides/firewall.md), зарегистрируйте первый аккаунт и создайте приглашения, как при [установке через Docker](docker.md).

## 5. Обновление

Сначала [сохраните данные](../operations/maintenance.md). Затем:

```sh
cd /opt/tolktak/server
sudo git pull
sudo UV_PYTHON_INSTALL_DIR=/opt/tolktak/python "$(command -v uv)" sync --no-dev
sudo systemctl restart tolktak
```

Миграции базы выполняются при старте. Версия сборки из исходников по умолчанию отображается как `0.1.0-dev`; релизная сборка записывает номер в `tolktak/_version.py`.
