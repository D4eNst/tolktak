# Сборка и тестирование

Нужны Python 3.14, [uv](https://docs.astral.sh/uv/), Node.js 22 с npm и LiveKit Server 1.13. Docker нужен только для проверки контейнерного развёртывания.

## Структура репозитория

| Каталог | Содержимое |
|---|---|
| `server/` | Python-сервер, REST и WebSocket, база, миграции и тесты |
| `client/src/main/` | Основной процесс Electron, захват и обновления |
| `client/src/preload/` | IPC-мост |
| `client/src/renderer/` | Интерфейс, обработка звука, переводы и API-клиент |
| `client/e2e/` | Сквозные тесты Playwright |
| `deploy/` | Установка через Compose и пример nginx |
| `website/` | Продуктовый сайт и генератор документации |
| `perf/`, `tools/voice-scores/` | Проверки ресурсов и качества голоса |

## Проверки сервера

```sh
cd server
uv sync
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
```

Тесты используют временную SQLite-базу. Для проверки PostgreSQL задайте `TOLKTAK_TEST_POSTGRES` с адресом отдельной тестовой базы.

`server/Dockerfile` собирает два образа. Цель по умолчанию, `full`, — это `d4enst/tolktak` с `livekit-server` внутри; `--target server` — `d4enst/tolktak-server`, только сервер:

```sh
docker build -t tolktak server
docker build --target server -t tolktak-server server
```

Релиз по тегу `v*` публикует оба образа на Docker Hub и в GHCR и прикладывает к релизу `deploy/install.sh`, `deploy/compose.yaml` и `deploy/example.env`. Для Docker Hub нужны секреты репозитория `DOCKERHUB_USERNAME` и `DOCKERHUB_TOKEN`. Тег `latest` переносится только на стабильные релизы.

## Локальный стек

LiveKit должен объявлять реальный LAN-адрес машины: Chromium игнорирует loopback ICE-кандидаты. Замените `192.168.1.20` адресом своего компьютера. Создайте `livekit-dev.yaml` вне репозитория:

```yaml
port: 7880
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
  node_ip: 192.168.1.20
keys:
  devkey: dev-secret-0123456789abcdefghijklmnop
webhook:
  api_key: devkey
  urls: ["http://127.0.0.1:8080/api/v1/livekit/webhook"]
```

В первом терминале:

```sh
livekit-server --config livekit-dev.yaml
```

Во втором:

```sh
cd server
TOLKTAK_REGISTRATION=open \
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET=dev-secret-0123456789abcdefghijklmnop \
LIVEKIT_PUBLIC_URL=ws://192.168.1.20:7880 \
uv run tolktak-server
```

Это тестовые ключи для локальной разработки. Сервер слушает 8080 и хранит данные в `server/data/`. Откройте `http://localhost:8080` и зарегистрируйтесь.

## Приложение

```sh
cd client
npm ci
npm start
```

Введите `localhost:8080` как адрес сервера.

| Команда | Назначение |
|---|---|
| `npm run build` | Сборка через esbuild в `dist/` |
| `npm run watch` | Пересборка при изменениях; Electron запускается отдельно |
| `npm run typecheck` | Проверка TypeScript |
| `npm run test:e2e` | Сквозные тесты |
| `npm run dist:win` | NSIS и zip на Windows |
| `npm run dist:mac` | DMG и zip на macOS |
| `npm run dist:linux` | AppImage и deb |

`TOLKTAK_DEFAULT_SERVER` задаёт адрес по умолчанию при сборке. `TOLKTAK_USER_DATA` выбирает отдельный профиль приложения. `TOLKTAK_NO_UPDATES` отключает проверку обновлений в упакованной сборке.

Серверы сами подхватывают опубликованный релиз, а приложения следуют за своим сервером, поэтому в релизе важны ещё две вещи. Если релиз меняет API так, что старые приложения с ним не справятся, поднимите `MIN_CLIENT_VERSION` в `server/tolktak/updates.py` до самой старой версии приложения, которая ещё работает: более старые обновятся перед подключением. Для срочного релиза безопасности поднимите её до версии самого релиза и добавьте в описание релиза `<!-- tolktak:urgent -->`: серверы в режиме `auto` поставят его сразу, не дожидаясь, пока в голосе никого не будет.

## Сквозные тесты

```sh
cd client
npm run build
LIVEKIT_BIN=/path/to/livekit-server npx playwright test
```

Тесты запускают реальный сервер, LiveKit и renderer. Проверки медиа используют декодированные кадры, уровни звука и RTP-статистику. Electron-тестам нужен дисплей; в Linux без дисплея используйте Xvfb. Тесты разрывов сети с `iptables` требуют root. Тестовая локаль — `ru-RU`.

Проверки шумоподавления находятся в `voice-quality.spec.ts`, `voice-worklet.spec.ts`, `denoise.spec.ts`. Проверка CPU — в `voice-cpu.spec.ts`, регрессии ресурсов — в `perf/ci.sh`. Windows-захват проверяется на реальной Windows-машине через `client/e2e/windows.spec.ts`.

Полная последовательность Windows-проверок и описание переменных доступны в [английской версии](https://tolktak.d4enst.ru/en/docs/development/building/).

## Сайт

```sh
cd website
npm ci
npm run build
npm run check
npm run preview
```

Откройте напечатанный локальный адрес. Генератор берёт инструкции из `docs/` и `docs/ru/`, создаёт HTML и поисковый индекс. Для публикации достаточно статического веб-сервера; Node.js в рабочем окружении сайта не нужен.
