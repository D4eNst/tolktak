# HTTP и WebSocket API

Приложение использует JSON API под `/api/v1`. Его можно вызывать из своих инструментов. Пока TolkTak находится в версии 0.x, API может меняться между релизами. Сверяйтесь с `client/src/renderer/api.ts` той же версии, что и сервер.

## Формат

Запросы и ответы используют JSON, кроме файлов. Время — Unix в миллисекундах. ID — целые числа, идентификаторы файлов — случайные строки.

Ошибка содержит HTTP-статус и объект:

```json
{"error":{"code":"invite_invalid","message":"Invite code is invalid, expired or used up"}}
```

Программы должны проверять `code`, а не английское `message`. При ограничении частоты запросов сервер отвечает `429`, код `rate_limited`.

## Вход

```http
POST /api/v1/auth/login
Content-Type: application/json

{"username":"alice","password":"…","device":"my-script"}
```

Ответ содержит `token` и `user`. Передавайте токен заголовком:

```http
Authorization: Bearer <token>
```

Он действует до `POST /api/v1/auth/logout`. Регистрация принимает `username`, `display_name`, `password` и, если требуется, `invite`. Для автоматизации создавайте отдельный аккаунт.

## Основные методы

Пути ниже указаны относительно `/api/v1`.

| Метод | Назначение |
|---|---|
| `GET /server` | Версия, имя, режим регистрации и адрес LiveKit; без входа |
| `POST /auth/register`, `/auth/login`, `/auth/logout` | Аккаунты и сессии |
| `GET /me`, `PATCH /me`, `POST /me/password` | Профиль и пароль |
| `GET /users` | Пользователи сервера |
| `GET /channels` | Доступные каналы и непрочитанные |
| `POST /dms` | Личный канал с `user_id` |
| `GET /channels/{id}/messages` | История: `before`, `after`, `limit`, `q` |
| `POST /channels/{id}/messages` | Сообщение: `text`, `nonce`, опциональные `reply_to`, `attachments` |
| `POST /channels/{id}/read` | Прочитано до `message_id` |
| `PATCH /messages/{id}`, `DELETE /messages/{id}` | Изменение и удаление своих сообщений |
| `POST /messages/{id}/reactions` | Переключение реакции `emoji` |
| `POST`, `DELETE /messages/{id}/pin`; `GET /channels/{id}/pins` | Закрепления |
| `POST /files?name=…` | Загрузка файла сырым телом запроса |
| `GET /files/{id}[/{name}]` | Скачивание без авторизации |
| `GET /groups`, `POST /groups`, `PATCH`, `DELETE /groups/{id}` | Группы |
| `POST /groups/{id}/members`, `DELETE /groups/{id}/members/{uid}` | Участники |
| `PUT /groups/{id}/members/{uid}/role` | Роли |
| `POST /groups/{id}/channels`, `PATCH`, `DELETE /text-channels/{id}` | Текстовые каналы |
| `POST /groups/{id}/rooms`, `PATCH`, `DELETE /rooms/{id}` | Голосовые комнаты |
| `POST /voice/join`, `/voice/leave` | Подключение к комнате по `room_id` или к звонку по `channel_id` |
| `POST /calls/{channel}/ring`, `/decline`, `/cancel` | Личные звонки |
| `GET`, `POST /admin/invites`, `DELETE /admin/invites/{code}` | Приглашения, только администратор |

`GET /healthz` находится вне `/api/v1`, возвращает `ok`.

## WebSocket

Подключитесь к `/api/v1/ws`. За первые 10 секунд отправьте токен первым кадром:

```json
{"type":"auth","token":"…"}
```

Не добавляйте токен в URL. После ответа `hello` сервер передаёт события в формате `{"type":"…","data":{…}}`.

| Событие | Назначение |
|---|---|
| `message.created`, `message.updated` | Новые и изменённые сообщения, реакции и закрепления |
| `channel.created`, `channel.deleted`, `channel.read` | Каналы и позиция чтения |
| `group.updated`, `group.deleted` | Состав и настройки группы |
| `user.created`, `user.updated`, `presence` | Пользователи и доступность |
| `typing` | Набор текста |
| `voice.room` | Участники комнаты и состояние медиа |
| `call.ring`, `call.declined`, `call.cancelled`, `call.ended` | Звонки |
| `ping` | Раз в 25 секунд; 70 секунд без кадров — потеря соединения |

После переподключения получите пропущенные данные через REST. Клиент может отправлять `{"type":"typing","channel_id":…}`.

## Медиа и боты

`POST /voice/join` возвращает `url`, `token` и `room` для LiveKit. Подключайтесь через [LiveKit SDK](https://docs.livekit.io/home/client/connect/). Токен действует только для этой комнаты.

Отдельного Bot API пока нет. Скрипт может работать как обычный пользователь. Специальные bot-аккаунты, права, webhooks и slash-команды только планируются.
