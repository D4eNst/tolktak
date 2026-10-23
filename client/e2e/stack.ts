import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
export const PORTS = { api: 18080, livekit: 17880, rtcTcp: 17881, web: 18090 };
const KEY = 'e2ekey';
const SECRET = 'e2e-secret-0123456789abcdefghijklmnopqrstuv';

export type Stack = { api: string; web: string; dataDir: string; stop(): Promise<void>; restartLivekit(): Promise<void> };

function hostIP(): string {
  // Chromium ignores loopback ICE candidates.
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  throw new Error('no non-loopback IPv4 interface');
}

async function waitHttp(url: string, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout waiting for ' + url);
}

function run(bin: string, args: string[], env: Record<string, string>, name: string): ChildProcess {
  const p = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (d: Buffer) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  p.stdout!.on('data', log);
  p.stderr!.on('data', log);
  return p;
}

export async function startStack(): Promise<Stack> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tolktak-e2e-'));
  const serverDir = path.join(ROOT, 'server');
  if (!process.env.TT_SERVER_BIN) execFileSync('uv', ['sync', '--locked', '--no-dev'], { cwd: serverDir, stdio: 'inherit' });
  const serverBin = process.env.TT_SERVER_BIN ?? path.join(serverDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', 'tolktak-server');
  const livekitBin = process.env.LIVEKIT_BIN ?? path.join(ROOT, '..', 'ext', 'livekit-server');
  if (!existsSync(livekitBin)) throw new Error('livekit-server not found: set LIVEKIT_BIN');

  const ip = hostIP();
  const lkConf = path.join(dataDir, 'livekit.yaml');
  writeFileSync(
    lkConf,
    `port: ${PORTS.livekit}
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: ${PORTS.rtcTcp}
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
  node_ip: ${ip}
keys:
  ${KEY}: ${SECRET}
webhook:
  api_key: ${KEY}
  urls: ["http://127.0.0.1:${PORTS.api}/api/v1/livekit/webhook"]
room:
  empty_timeout: 30
  # LiveKit's default list plus H.264 Baseline 42001f. Chromium offers 42001f first and
  # encodes it on the GPU (any vendor) when it can; the default Constrained Baseline 42e01f
  # is always software (OpenH264) on Windows.
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: audio/PCMU
    - mime: audio/PCMA
    - mime: video/H264
      fmtp_line: level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    - mime: video/H264
    - mime: video/VP8
    - mime: video/VP9
    - mime: video/AV1
    - mime: video/H265
    - mime: video/rtx
logging:
  level: info
`,
  );
  let livekit = run(livekitBin, ['--config', lkConf], {}, 'livekit');
  const server = run(
    serverBin,
    [],
    {
      TOLKTAK_DATA_DIR: dataDir,
      TOLKTAK_LISTEN: `127.0.0.1:${PORTS.api}`,
      TOLKTAK_REGISTRATION: 'open',
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      LIVEKIT_PUBLIC_URL: `ws://${ip}:${PORTS.livekit}`,
      LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${PORTS.livekit}`,
      TOLKTAK_SERVER_NAME: 'E2E',
    },
    'server',
  );
  const dist = path.join(__dirname, '..', 'dist');
  const web: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let f = path.join(dist, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!existsSync(f) || statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(f)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(f).pipe(res);
  });
  await new Promise<void>((r) => web.listen(PORTS.web, '127.0.0.1', r));
  await waitHttp(`http://127.0.0.1:${PORTS.livekit}/`);
  await waitHttp(`http://127.0.0.1:${PORTS.api}/healthz`);

  return {
    api: `http://127.0.0.1:${PORTS.api}`,
    web: `http://127.0.0.1:${PORTS.web}`,
    dataDir,
    async restartLivekit() {
      livekit.kill('SIGKILL');
      await new Promise((r) => livekit.once('exit', r));
      livekit = run(livekitBin, ['--config', lkConf], {}, 'livekit');
      await waitHttp(`http://127.0.0.1:${PORTS.livekit}/`);
    },
    async stop() {
      // A new stack must not find the old LiveKit still holding its ports.
      await Promise.all(
        [livekit, server].map(async (p) => {
          if (p.exitCode !== null || p.signalCode !== null) return;
          const exited = new Promise((r) => p.once('exit', r));
          p.kill('SIGTERM');
          const t = setTimeout(() => p.kill('SIGKILL'), 10_000);
          await exited;
          clearTimeout(t);
        }),
      );
      web.close();
    },
  };
}

/** Needs root. */
export async function outage(ms: number) {
  const rules = [
    ['-p', 'tcp', '--dport', String(PORTS.livekit)],
    ['-p', 'tcp', '--dport', String(PORTS.rtcTcp)],
    ['-p', 'udp', '--dport', '50000:50200'],
    ['-p', 'tcp', '--dport', String(PORTS.api)],
  ];
  for (const r of rules) execFileSync('iptables', ['-I', 'INPUT', ...r, '-j', 'DROP']);
  try {
    await new Promise((res) => setTimeout(res, ms));
  } finally {
    for (const r of rules) execFileSync('iptables', ['-D', 'INPUT', ...r, '-j', 'DROP']);
  }
}

export async function register(apiBase: string, username: string, password = 'password123') {
  const r = await fetch(apiBase + '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, display_name: username[0].toUpperCase() + username.slice(1), password }),
  });
  if (!r.ok) throw new Error(`register ${username}: ${r.status} ${await r.text()}`);
  return (await r.json()) as { token: string; user: { id: number } };
}

export async function loginToken(apiBase: string, username: string, password = 'password123'): Promise<string> {
  const r = await fetch(apiBase + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device: 'e2e' }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}
