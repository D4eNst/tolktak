# Настройки

Сервер настраивается переменными окружения. В Docker они находятся в `deploy/.env`, при [запуске через systemd](../install/source.md) — в `/etc/tolktak/.env`. После изменений выполните `docker compose up -d` или перезапустите службу.

## Основные параметры

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TOLKTAK_SERVER_NAME` | `TolkTak` | Имя в приложении и на странице сервера |
| `TOLKTAK_REGISTRATION` | `invite` | `open`, `invite` или `closed`. Первый аккаунт доступен при любом режиме и становится администратором |
| `TOLKTAK_MAX_UPLOAD_MB` | `50` | Размер одного файла в МБ. Лимит прокси должен быть выше |
| `TOLKTAK_CLIENT_DOWNLOAD_URL` | Пусто | Ссылка на приложение на странице сервера. Пустое значение скрывает кнопку |
| `LIVEKIT_PUBLIC_URL` | Обязателен | Доступный участникам адрес LiveKit: `wss://` с HTTPS, `ws://` без него |
| `LIVEKIT_API_KEY` | Обязателен | Ключ из `keys` в `livekit.yaml` |
| `LIVEKIT_API_SECRET` | Обязателен | Секрет из того же файла, не короче 32 символов |
| `LIVEKIT_INTERNAL_URL` | `http://127.0.0.1:7880` | Адрес API LiveKit для самого сервера |
| `TOLKTAK_LISTEN` | `:8080` | Адрес прослушивания. В Compose задаётся через bind и port |
| `TOLKTAK_DATA_DIR` | `./data` | Загрузки и SQLite. В контейнере — `/data` |
| `TOLKTAK_DATABASE_URL` | Пусто | Пусто — SQLite в каталоге данных. `postgres://user:password@host:5432/dbname` — PostgreSQL. Допустим `sqlite:///absolute/path.db` |
| `TOLKTAK_TRUST_PROXY` | Выключен | `1` берёт адрес клиента из последнего значения `X-Forwarded-For`, которое добавляет прокси. Включайте только при доступе исключительно через свой прокси |
| `TOLKTAK_DEBUG` | Выключен | `1` включает подробные журналы |

Если обязательная переменная не задана или значение недопустимо, сервер завершится с сообщением о причине.

## Параметры Docker Compose

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TOLKTAK_VERSION` | `latest` | Тег образа сервера. Укажите версию, чтобы обновляться вручную |
| `TOLKTAK_BIND`, `LIVEKIT_BIND` | `127.0.0.1` | `0.0.0.0` при прямом HTTP-доступе |
| `TOLKTAK_PORT`, `LIVEKIT_PORT` | `8080`, `7880` | HTTP-порты |
| `RTC_TCP_PORT` | `7881` | Медиа по TCP |
| `RTC_UDP_START`, `RTC_UDP_END` | `50000`, `60000` | Диапазон медиа по UDP |
| `TURN_UDP_PORT` | `3478` | TURN |
| `TURN_RELAY_START`, `TURN_RELAY_END` | `30000`, `40000` | Диапазон TURN relay |

`init.sh` записывает порты также в `livekit.yaml`. Изменение только `.env` не перенастроит LiveKit. Порядок изменения описан в [инструкции по портам](../guides/firewall.md).

## LiveKit

- `rtc.use_external_ip` определяет публичный IP через STUN. Для сервера в интернете оставьте `true`.
- `rtc.interfaces` ограничивает сетевые интерфейсы. Полезно при наличии VPN и Docker-мостов.
- `turn` включает встроенный TURN по UDP. TURN по TLS на 443 в шаблоне не настроен.
- `webhook.urls` должен вести на `/api/v1/livekit/webhook` сервера TolkTak: так обновляется список участников комнат.

Полный список параметров — в [официальной документации LiveKit](https://docs.livekit.io/home/self-hosting/deployment/).
