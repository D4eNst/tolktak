# PostgreSQL

[Установка через Compose](../install/compose.md) запускает PostgreSQL рядом с TolkTak. Сервер, запущенный [через `docker run`](../install/docker.md) или [из исходников](../install/source.md), по умолчанию хранит базу в файле `tolktak.db`: для небольшого сервера SQLite позволяет начать без настройки отдельной базы. PostgreSQL удобен, когда важны параллельная запись, отдельное обслуживание базы и её собственные инструменты резервного копирования.

Загруженные файлы в базе не хранятся; о них — в [инструкции по S3](s3.md). Сначала можно запустить SQLite и перенести базу позже. База выбирается переменной `TOLKTAK_DATABASE_URL`; строка журнала `tolktak-server listening` показывает `database=postgres` или `database=sqlite`.

## PostgreSQL в установке через Compose

Его настраивает установщик: сервис `postgres` хранит данные в томе `postgres-data`, база и пользователь называются `tolktak`, а пароль — `POSTGRES_PASSWORD` в `.env`. База доступна только другим сервисам установки, снаружи её не видно.

Мажорная версия закреплена в `compose.yaml` (`postgres:17`). Новая мажорная версия не откроет старый каталог данных; переход на неё требует дампа и восстановления, как в разделе [«Резервная копия»](#резервная-копия).

## Уже существующая база

Подойдёт любой доступный серверу PostgreSQL: на этой же машине, на другой или облачный. Создайте пользователя и базу от имени администратора PostgreSQL:

```sql
CREATE USER tolktak WITH PASSWORD 'choose-a-password';
CREATE DATABASE tolktak OWNER tolktak;
```

TolkTak создаст таблицы при старте. Передайте серверу адрес:

- **Compose:** задайте `TOLKTAK_DATABASE_URL` в `.env`, уберите `postgres` из `COMPOSE_PROFILES`, затем выполните `docker compose up -d` и `docker compose rm -sf postgres`.
- **`docker run`:** добавьте к команде `-e TOLKTAK_DATABASE_URL=...`.
- **Установка из исходников:** добавьте строку в `/etc/tolktak/.env` и перезапустите службу.

```sh
TOLKTAK_DATABASE_URL=postgres://tolktak:choose-a-password@db.example.com:5432/tolktak
```

Пароль из латинских букв и цифр не требует экранирования в URL. В остальных случаях символы `@`, `:`, `/`, `#` нужно кодировать через percent-encoding.

При удалённой базе разрешите доступ только серверу TolkTak через `pg_hba.conf` и файрвол. Задержка до базы влияет почти на каждый запрос. PostgreSQL на той же машине изнутри контейнера в установке через Compose доступен не по `127.0.0.1`: он должен слушать адрес Docker-моста.

## Перенос с SQLite

Сначала [сделайте резервную копию](../operations/maintenance.md). База назначения должна быть пустой: команда откажется писать в базу, где уже есть аккаунты. Сессии копируются вместе с остальными данными: участники остаются авторизованы.

Переезд с сервера `docker run` на установку через Compose описан в разделе [«Переезд с docker run»](../install/compose.md#переезд-с-docker-run). Для установки из исходников:

```sh
sudo systemctl stop tolktak
sudo -u tolktak /opt/tolktak/server/.venv/bin/tolktak-server copy-db \
  sqlite:///var/lib/tolktak/tolktak.db postgres://tolktak:<password>@127.0.0.1:5432/tolktak
```

Затем добавьте `TOLKTAK_DATABASE_URL` в `/etc/tolktak/.env` и выполните `sudo systemctl start tolktak`.

Не удаляйте SQLite-файл до проверки. Для возврата уберите `TOLKTAK_DATABASE_URL`, но учтите: новые записи, сделанные после переноса в PostgreSQL, не появятся в старом SQLite-файле. `copy-db` умеет переносить данные и в обратном направлении — в пустую базу.

## Резервная копия

Копия состоит из дампа базы, загруженных файлов и `.env`. В установке через Compose, из каталога с `compose.yaml`:

```sh
docker compose exec -T postgres pg_dump -U tolktak -Fc tolktak > tolktak-db-$(date +%F).dump
```

`pg_dump` создаёт согласованный снимок без остановки базы. Файлы сохраняются по [инструкции по обслуживанию](../operations/maintenance.md#резервные-копии). Для восстановления остановите TolkTak:

```sh
docker compose stop tolktak
docker compose exec -T postgres pg_restore -U tolktak -d tolktak --clean --if-exists < tolktak-db-2026-01-31.dump
docker compose start tolktak
```

Восстановление заменяет данные базы. Сначала проверьте его на отдельной тестовой базе.
