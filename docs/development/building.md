# Building and testing

## Prerequisites

- Python 3.14 and [uv](https://docs.astral.sh/uv/) (see [`server/pyproject.toml`](../../server/pyproject.toml); uv can install Python for you)
- Node.js 22 and npm
- [LiveKit server](https://github.com/livekit/livekit/releases) 1.13 (`livekit-server` binary), for running a local stack and the end-to-end tests
- Docker, only if you want to test the deployment

## Repository layout

| Path | Contents |
|---|---|
| `server/` | Python server, package `tolktak`. `__main__.py` is the `tolktak-server` entry point and `app.py` builds the FastAPI application; `api/` (HTTP and WebSocket handlers), `store/` and `db.py` (database access and schema migrations, SQLite or PostgreSQL), `realtime.py` (WebSocket hub), `livekit.py` (tokens, webhooks, API calls), `web/` (website), `copydb.py` (the `copy-db` command). Tests are in `server/tests/`. |
| `client/src/main/` | Electron main process: window, tray, hotkeys, screen and audio capture, updater. |
| `client/src/preload/` | The IPC bridge exposed to the renderer. |
| `client/src/renderer/` | UI (`ui/`), voice and video (`voice.ts`, `audio/`), API client, translations (`i18n/`). |
| `client/e2e/` | Playwright end-to-end tests. |
| `tools/voice-scores/` | DNSMOS, PESQ and STOI thresholds for `voice-quality.spec.ts`. |
| `perf/` | CPU and memory regression runs of the client on Linux (`perf.yml`). |
| `deploy/` | The Compose setup and an nginx example. |

See [Architecture](architecture.md) for how the pieces fit together.

## Server

```sh
cd server
uv sync
uv run ruff check . && uv run ruff format --check . && uv run ty check
uv run pytest
```

The tests use a temporary SQLite database and need no external services. To run every test against PostgreSQL as well, point `TOLKTAK_TEST_POSTGRES` at a database you can use for that:

```sh
TOLKTAK_TEST_POSTGRES=postgres://tolktak:secret@127.0.0.1:5432/tolktak_test uv run pytest
```

The release version is written into `tolktak/_version.py` when the Docker image is built (build argument `VERSION`); a checkout reports `0.1.0-dev`. The build argument `REPOSITORY`, which the release workflow sets to the repository it runs in, decides whose GitHub releases the server follows for updates, so a fork's server follows the fork.

`server/Dockerfile` builds two images. The default target, `full`, is `d4enst/tolktak` with `livekit-server` inside; `--target server` is `d4enst/tolktak-server`, the server alone:

```sh
docker build -t tolktak server
docker build --target server -t tolktak-server server
```

## Running a local stack

Chromium ignores loopback ICE candidates, so LiveKit must advertise a real network address of your machine, even when everything runs locally. Replace `192.168.1.20` below with your LAN address.

Create `livekit-dev.yaml` outside the repository:

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

Start LiveKit and the server in two terminals:

```sh
livekit-server --config livekit-dev.yaml
```

```sh
cd server
TOLKTAK_REGISTRATION=open \
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET=dev-secret-0123456789abcdefghijklmnop \
LIVEKIT_PUBLIC_URL=ws://192.168.1.20:7880 \
uv run tolktak-server
```

The server listens on `:8080` and keeps its data in `server/data/`. Open `http://localhost:8080` to register the first account. All server variables are listed in [Configuration](../operations/configuration.md).

## Client

```sh
cd client
npm ci
npm start            # build once and launch Electron
```

Enter `localhost:8080` as the server address. Addresses on `localhost` and private networks default to `http://`, everything else to `https://`.

| Script | What it does |
|---|---|
| `npm run build` | Bundle main, preload and renderer into `dist/` with esbuild |
| `npm run watch` | Rebuild on every change; run `npx electron .` in another terminal and restart it to pick up changes |
| `npm start` | Build and launch the app |
| `npm run typecheck` | Type-check the whole client with `tsc` |
| `npm run test:e2e` | Run the Playwright tests (see below) |
| `npm run dist:win` | Build the Windows NSIS installer and zip into `release/` (run on Windows) |
| `npm run dist:win:zip` | Build only the portable Windows zip (works from Linux) |
| `npm run dist:mac` | Build macOS `.dmg` and `.zip` for arm64 and x64 (run on macOS) |
| `npm run dist:linux` | Build the Linux AppImage and `.deb` |

Environment variables for the client:

| Variable | Used by | Effect |
|---|---|---|
| `TOLKTAK_DEFAULT_SERVER` | build | Prefills the server address on the login screen, for builds made for one community |
| `NODE_ENV=production` | build | Minifies the bundle and drops source maps |
| `TOLKTAK_USER_DATA` | app | Uses a different profile directory, so several instances can run side by side |
| `TOLKTAK_NO_UPDATES` | app | Disables the update check in a packaged build |

Releases are built by [`.github/workflows/release.yml`](../../.github/workflows/release.yml) when a `v*` tag is pushed: it builds the installers for all three platforms, publishes them to GitHub Releases, pushes both images to Docker Hub (`d4enst/tolktak`, `d4enst/tolktak-server`) and GHCR (`ghcr.io/d4enst/...`), and attaches `deploy/install.sh`, `deploy/compose.yaml` and `deploy/example.env` to the release. Docker Hub needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. `latest` moves only on stable releases.

## End-to-end tests

The tests in `client/e2e/` start a real stack: they start `tolktak-server` from `server/` on port 18080, start `livekit-server` with a generated configuration on ports 17880 and 17881, and serve the renderer bundle from `client/dist` on port 18090. Nothing on the server side is mocked. Media assertions look at real decoded frames, audio levels and RTP statistics, not at what the UI shows.

```sh
cd client
npm run build
LIVEKIT_BIN=/path/to/livekit-server npx playwright test
```

Notes:

- `LIVEKIT_BIN` points to the LiveKit binary. `CHROMIUM_PATH` selects a Chromium build instead of the one Playwright installs (`npx playwright install chromium`).
- The specs that launch Electron (`electron.spec.ts`, `audio.spec.ts`, `chat.spec.ts`) need a display. On a headless Linux machine, run them under `xvfb-run -a`.
- The network-loss tests in `resilience.spec.ts` drop traffic with `iptables` and must run as root.
- The test locale is `ru-RU` and the specs look up Russian UI labels, so keep both translations in sync when you change a string the tests use.
- `long.spec.ts` is a long watch-together session, skipped unless `LONG_MIN=<minutes>` is set. `E2E_VERBOSE=1` prints the server and LiveKit logs.

### Voice quality and resource checks

These run in CI and can be run locally the same way:

- `voice-quality.spec.ts`, `voice-worklet.spec.ts` and `denoise.spec.ts` render the shipped noise suppressors offline. With [uv](https://docs.astral.sh/uv/) installed, `voice-quality.spec.ts` also scores the output with `tools/voice-scores/score.py` against `thresholds.json` (run `uv sync --project ../tools/voice-scores` once).
- `voice-cpu.spec.ts` measures the CPU cost of each preset in Electron; on Linux run it under `xvfb-run -a`.
- `perf/ci.sh` starts the stack with real Electron clients, measures idle and call scenarios and checks them against `perf/baseline/ci-linux.json`. It needs `LIVEKIT_BIN`, the server environment (`uv sync` in `server/`) and Xvfb. A single run: `perf/run.sh voice --clients 2 --duration 40`.

### Windows capture tests

`client/e2e/windows.spec.ts` checks screen sharing on a real Windows PC: that a shared window's audio reaches viewers without the voices of the room, and which video encoder is actually used. It runs only on Windows with `TT_API` set.

1. Install the server and download LiveKit:

   ```powershell
   cd server
   uv sync --no-dev
   ```

   Put `livekit-server.exe` from the [LiveKit releases](https://github.com/livekit/livekit/releases) into the same `bin\` folder at the repository root.

2. Start the stack from the repository root. The script picks your LAN address, writes the configuration and database to `data\`, and prints the API address:

   ```powershell
   powershell -ExecutionPolicy Bypass -File client\e2e\windows\start-stack.ps1
   ```

3. Build the client and run the tests:

   ```powershell
   cd client
   npm ci; npm run build
   $env:TT_API = "http://<lan-ip>:8080"
   npx playwright test e2e/windows.spec.ts
   ```

Results are written to `windows-results.json`, `gpu-results.json` and `hw-results.json` in `client/` (or in `TT_RESULTS_DIR`).

`client/e2e/windows/windows-probe.ps1` is a read-only script that collects the Windows build, CPU, GPU and driver, displays and audio devices into `tolktak-probe.txt` on the desktop. Attaching its output helps when reporting capture problems.
