# PostgreSQL

По умолчанию TolkTak хранит базу в файле `tolktak.db`. Для небольшого сервера SQLite позволяет начать без настройки отдельной базы. PostgreSQL удобен, когда важны параллельная запись, отдельное обслуживание базы и её собственные инструменты резервного копирования.

Файлы пользователей в обоих случаях остаются в каталоге данных TolkTak. Сначала можно запустить SQLite и перенести базу позже.

## PostgreSQL рядом с TolkTak

Создайте `deploy/docker-compose.override.yml`. Compose автоматически объединит его с основным файлом:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: tolktak
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: tolktak
    ports:
      - 127.0.0.1:5432:5432
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tolktak -d tolktak"]
      interval: 5s
      timeout: 5s
      retries: 10
  tolktak:
    depends_on:
      postgres:
        condition: service_healthy
volumes:
  postgres-data:
```

TolkTak использует сеть хоста, поэтому обращается к базе по `127.0.0.1:5432`, а не по имени `postgres`.

Сгенерируйте пароль через `openssl rand -hex 24`. Добавьте в `.env` две строки с этим значением:

```sh
POSTGRES_PASSWORD=<сгенерированный пароль>
TOLKTAK_DATABASE_URL=postgres://tolktak:<сгенерированный пароль>@127.0.0.1:5432/tolktak
```

Шестнадцатеричный пароль не требует экранирования в URL. В собственном пароле символы `@`, `:`, `/`, `#` нужно кодировать через percent-encoding.

Для нового сервера выполните `docker compose up -d`. Для сервера с существующими данными сначала сделайте перенос, иначе он откроет пустую PostgreSQL-базу.

## Уже существующая база

Создайте пользователя и базу от имени администратора PostgreSQL:

```sql
CREATE USER tolktak WITH PASSWORD 'choose-a-password';
CREATE DATABASE tolktak OWNER tolktak;
```

Укажите адрес через `TOLKTAK_DATABASE_URL` в `.env`. TolkTak создаст таблицы при старте. При удалённой базе разрешите доступ только серверу TolkTak через `pg_hba.conf` и файрвол. Задержка до базы влияет почти на каждый запрос.

## Перенос с SQLite

Сначала [сделайте резервную копию](../operations/maintenance.md). База назначения должна быть пустой: команда откажется писать в базу, где уже есть аккаунты.

```sh
cd tolktak/deploy
docker compose stop tolktak
docker compose run --rm tolktak copy-db sqlite:///data/tolktak.db \
  postgres://tolktak:<password>@127.0.0.1:5432/tolktak
```

Задайте `TOLKTAK_DATABASE_URL` в `.env` и запустите `docker compose up -d`. Сессии копируются вместе с остальными данными: участники остаются авторизованы. Загрузки перемещать не нужно.

Не удаляйте SQLite-файл до проверки. Для возврата уберите `TOLKTAK_DATABASE_URL`, но учтите: новые записи, сделанные после переноса в PostgreSQL, не появятся в старом SQLite-файле. `copy-db` умеет переносить данные и в обратном направлении — в пустую базу.

## Резервная копия

Копия состоит из дампа базы, каталога `files/` и конфигурации сервера.

```sh
docker compose exec -T postgres pg_dump -U tolktak -Fc tolktak > tolktak-db.dump
```

`pg_dump` создаёт согласованный снимок без остановки базы. Для восстановления остановите TolkTak:

```sh
docker compose stop tolktak
docker compose exec -T postgres pg_restore -U tolktak -d tolktak --clean --if-exists < tolktak-db.dump
docker compose start tolktak
```

Восстановление заменяет данные базы. Сначала проверьте его на отдельной тестовой базе. Не публикуйте PostgreSQL в интернете и закрепляйте мажорную версию образа: её смена требует отдельной миграции.
