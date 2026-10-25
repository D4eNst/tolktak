# Установка через Docker Compose

Эта установка рассчитана на постоянный сервер: свой домен с HTTPS, PostgreSQL для базы, хранилище S3 для файлов и LiveKit в отдельном контейнере. Её описывает один файл `compose.yaml`, и любой из встроенных сервисов можно заменить своим. Установщик спрашивает, что из этого нужно, и записывает настройки.

| Сервис | Образ | Назначение |
|---|---|---|
| `tolktak` | `d4enst/tolktak-server` | Сервер TolkTak |
| `livekit` | `livekit/livekit-server` | Голос, видео и трансляции |
| `postgres` | `postgres:17` | База данных |
| `garage` | `dxflrs/garage` | [Garage](https://garagehq.deuxfleurs.fr/), хранилище S3 для загруженных файлов |
| `caddy` | `caddy:2.11` | HTTPS с сертификатами Let's Encrypt, которые выпускаются и продлеваются автоматически |

Нужны Linux-сервер с Docker Engine, плагином Compose версии 2.23.1 или новее (`docker compose version`) и `openssl`, а для HTTPS — доменное имя. Подробнее — в [требованиях](requirements.md). Чтобы сначала просто попробовать TolkTak, достаточно [одной команды `docker run`](docker.md).

## 1. Домен

Создайте DNS-запись для имени, по которому будут подключаться участники, с публичным IP сервера:

| Имя | Тип | Значение |
|---|---|---|
| `chat.example.com` | A | `203.0.113.10` |

Одного имени достаточно: LiveKit доступен через тот же домен. `dig +short chat.example.com` должна вернуть адрес сервера. Про IPv6 и CDN-прокси — в инструкции [о доменах и адресах](../guides/domains.md).

## 2. Установка

```sh
mkdir tolktak && cd tolktak
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/install.sh && sh install.sh
```

Установщик проверяет, что есть Docker, Compose и `openssl`, и скачивает `compose.yaml` и `example.env` из последнего релиза. Затем задаёт вопросы на английском:

| Вопрос | Варианты; первый — по умолчанию |
|---|---|
| Как подключаться к серверу | Домен с сертификатом от Caddy; домен за своим обратным прокси; IP-адрес по обычному HTTP |
| База | PostgreSQL в этой установке, с паролем, созданным автоматически; свой PostgreSQL; SQLite |
| Загруженные файлы | Garage в этой установке; свой бакет S3; диск сервера |
| Обновления сервера | Вручную, автоматически или выключены (`TOLKTAK_UPDATES`) |
| Название сервера | `TolkTak` |

Enter принимает значение в скобках. Данные своего PostgreSQL или S3 можно ввести сразу или позже в `.env`. Установщик записывает `.env` с созданными секретами и доступом только для владельца, печатает порты, которые нужно открыть, и предлагает запустить сервер. За пределами каталога он ничего не меняет и останавливается, если `.env` уже есть. `install.sh` можно прочитать до запуска.

В `.env` хранятся секреты: не публикуйте его и включайте в резервные копии. Любую настройку можно потом изменить там же; `docker compose up -d` применяет изменения.

### Без установщика

```sh
mkdir tolktak && cd tolktak
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/D4eNst/tolktak/releases/latest/download/example.env
```

Впишите домен в `.env` строкой `TOLKTAK_DOMAIN=chat.example.com`, затем один раз допишите случайные пароли и ключи:

```sh
cat >> .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
GARAGE_ACCESS_KEY=GK$(openssl rand -hex 12)
GARAGE_SECRET_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

Остальные параметры в `.env` необязательны, они описаны в [справочнике конфигурации](../operations/configuration.md). Если обязательного значения нет, Compose не запустится и назовёт его.

## 3. Порты

| Порт | Протокол | Назначение |
|---|---|---|
| 80 | TCP | Выпуск сертификата и перенаправление на HTTPS |
| 443 | TCP и UDP | HTTPS |
| 7881 | TCP | Звонки, если сеть участника блокирует UDP |
| 7882 | UDP | Голос, видео и демонстрация экрана |

Откройте их в файрволе сервера и в панели хостинга. При своём обратном прокси 80 и 443 — это его порты; по обычному HTTP вместо них откройте 8080/TCP и 7880/TCP. Подробнее — в [инструкции по портам](../guides/firewall.md).

## 4. Запуск

Если установщик ещё не запустил сервер:

```sh
docker compose up -d
docker compose ps
```

При первом запуске Caddy получает сертификат для домена, это занимает до минуты. Журналы:

```sh
docker compose logs -f tolktak livekit caddy
```

Откройте `https://chat.example.com` и зарегистрируйтесь. **Первый аккаунт становится администратором.** Затем проверьте звонок между двумя аккаунтами, лучше из разных сетей: работающий чат не доказывает, что порты для звонков открыты.

## Своя база, хранилище или прокси

`COMPOSE_PROFILES` в `.env` перечисляет встроенные сервисы, которые запускает Compose:

```sh
COMPOSE_PROFILES=livekit,postgres,garage,caddy,updater
```

Чтобы использовать свой сервис, уберите встроенный из списка, задайте замену в том же `.env` и выполните `docker compose up -d`. Уже запущенный встроенный сервис при этом продолжит работать; удалите его командой `docker compose rm -sf garage` (или `livekit`, `postgres`, `caddy`). Его том сохранится.

- **Свой или облачный PostgreSQL:** уберите `postgres` и задайте `TOLKTAK_DATABASE_URL`. Подробнее — в [инструкции по PostgreSQL](../guides/postgres.md).
- **S3 провайдера**, например AWS S3, Cloudflare R2 или Backblaze B2: уберите `garage` и задайте переменные `TOLKTAK_S3_*`. Чтобы хранить файлы на диске сервера, задайте пустое `TOLKTAK_S3_BUCKET=`. Подробнее — в [инструкции по S3](../guides/s3.md).
- **Свой обратный прокси**, который уже занимает порты 80 и 443, например nginx: уберите `caddy`. TolkTak слушает `127.0.0.1:8080`, LiveKit — `127.0.0.1:7880`. Направьте домен на первый, а путь `/rtc` — на второй, как в [инструкции по обратному прокси](../guides/reverse-proxy.md). Если порт 8080 или 7880 занят, задайте `TOLKTAK_PORT` или `LIVEKIT_PORT`.

- **LiveKit на другом сервере**, например LiveKit Cloud: уберите `livekit` и задайте `LIVEKIT_PUBLIC_URL`, `LIVEKIT_INTERNAL_URL`, `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET`. Они описаны в [справочнике конфигурации](../operations/configuration.md#livekit).

Храните свои настройки в `.env`: обновление заменяет `compose.yaml`. Изменения, которых нет в `.env`, записывайте в `compose.override.yaml` рядом с ним: Compose подключает этот файл автоматически, а обновления его не трогают.

## Переезд с docker run

Данные сервера, запущенного [через `docker run`](docker.md), лежат в томе `tolktak-data`: база SQLite и загруженные файлы. Переносите их до того, как на новом сервере кто-то зарегистрируется: копирование базы требует пустой базы назначения.

```sh
docker stop tolktak
docker compose up -d postgres garage
docker compose run --rm -v tolktak-data:/old tolktak copy-db sqlite:///old/tolktak.db
docker compose run --rm -v tolktak-data:/old -e TOLKTAK_DATA_DIR=/old tolktak copy-files
docker compose up -d
```

`copy-db` копирует аккаунты, чаты и сессии в базу сервера, `copy-files` загружает файлы в бакет S3. Файлы в старом томе остаются, но `copy-db` сначала обновляет его базу до схемы сервера, и старая версия на ней больше не запустится. Удалите том командой `docker volume rm tolktak-data`, когда убедитесь, что новый сервер работает. Участники остаются в своих аккаунтах, но адрес сервера меняется: в приложении нужно выйти и ввести `https://chat.example.com`.

## Обновление

Сервис `updater`, который установщик включает, если не выбрать «выключены», ставит новые релизы согласно `TOLKTAK_UPDATES` в `.env`: при `manual`, по умолчанию, обновление запускает администратор в «Настройки → Сервер»; при `auto` сервер ставит его сам, когда в голосе никого нет. См. [«Обновления и резервные копии»](../operations/maintenance.md#обновление). Сервису нужен Docker-сокет, и он заменяет только образ сервера, записывая установленный релиз в `TOLKTAK_VERSION` в `.env`. `compose.yaml` он не заменяет, а там закреплены версии LiveKit, PostgreSQL, Garage, Caddy и самого `updater`, поэтому время от времени обновляйтесь вручную, как описано ниже. Compose он запускает внутри своего контейнера, поэтому пути на хосте в `compose.override.yaml` указывайте абсолютные. Чтобы обновлять только вручную, уберите `updater` из `COMPOSE_PROFILES` и выполните `docker compose rm -sf updater`.

Вручную сначала прочитайте [описание релиза](https://github.com/D4eNst/tolktak/releases) и сделайте [резервную копию](../operations/maintenance.md#резервные-копии): новая версия при запуске обновляет базу.

```sh
curl -fsSLO https://github.com/D4eNst/tolktak/releases/latest/download/compose.yaml
docker compose pull
docker compose up -d
```

Первая команда заменяет `compose.yaml`, где закреплены версии LiveKit и других образов; ваши настройки остаются в `.env` и `compose.override.yaml`. Если `TOLKTAK_VERSION` закреплена, сначала смените её в `.env` на новый релиз.

## Дальше

- [Администрирование](../operations/administration.md): приглашения и доступы.
- [Обслуживание](../operations/maintenance.md): резервные копии томов и базы.
- [Решение проблем](../operations/troubleshooting.md).
