# Начало работы

## Приложение

- [Загрузки](https://tolktak.d4enst.ru/download/) — сборки для Windows, macOS и Linux.
- [Инструкция к приложению](install/desktop-app.md) — установка, регистрация, разрешения и обновления.

## Собственный сервер

TolkTak можно разместить на своём оборудовании или арендованном сервере.

- [Требования](install/requirements.md)
- [Установка через Docker](install/docker.md) — одна команда `docker run`.
- [Установка через Docker Compose](install/compose.md) — свой домен с HTTPS, PostgreSQL и S3.
- [Установка из исходников](install/source.md)

## Настройка и обслуживание

- [Параметры сервера](operations/configuration.md) — переменные окружения и настройки LiveKit.
- [PostgreSQL](guides/postgres.md) и [хранилище S3](guides/s3.md) — база и загруженные файлы.
- [Администрирование](operations/administration.md) — регистрация, приглашения и доступы.
- [Обновления и резервные копии](operations/maintenance.md) — сохранение и восстановление данных.
- [Решение проблем](operations/troubleshooting.md) — подключение, звук и журналы сервисов.

TolkTak находится на ранней стадии разработки. Перед обновлением нужна резервная копия данных. Сквозного шифрования пока нет: владелец сервера имеет доступ к хранящимся на нём сообщениям и файлам. Подробнее — в [описании безопасности](../development/architecture.md#security-model) (на английском).

## Разработка

Документация для разработчиков написана на английском: [архитектура](../development/architecture.md), [сборка и тестирование](../development/building.md), [HTTP и WebSocket API](../development/api.md).
