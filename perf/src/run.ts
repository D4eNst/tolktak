// Usage: perf/run.sh <idle-tray|idle-chat|voice> [--clients N] [--duration S] [--warmup S]
//                    [--window front|back] [--label TEXT] [--out FILE]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loginToken, PORTS, register, startStack } from '../../client/e2e/stack';
import { launchElectron, type ElectronClient } from './cdp';
import { PROBE_SCRIPT } from './probe';
import { makeSampler, type Snapshot } from './sampler';

const CLIENT_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(CLIENT_DIR, '..');
const SCHEMA = 'tolktak-perf/1';
const SCENARIOS: Record<string, number> = { 'idle-tray': 1, 'idle-chat': 1, voice: 2 }; // default client counts

type Opts = { scenario: string; clients: number; duration: number; warmup: number; window: 'front' | 'back'; label?: string; out?: string };

function parseArgs(argv: string[]): Opts {
  const o: Opts = { scenario: argv[0] ?? '', clients: 0, duration: 60, warmup: 15, window: 'front' };
  if (!(o.scenario in SCENARIOS)) throw new Error(`unknown scenario "${o.scenario}": ${Object.keys(SCENARIOS).join(', ')}`);
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case '--clients': o.clients = Number(value); break;
      case '--duration': o.duration = Number(value); break;
      case '--warmup': o.warmup = Number(value); break;
      case '--window': o.window = value as Opts['window']; break;
      case '--label': o.label = value; break;
      case '--out': o.out = value; break;
      default: throw new Error('unknown option ' + argv[i]);
    }
  }
  o.clients ||= SCENARIOS[o.scenario];
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** 48 kHz mono 16-bit, noise at about -70 dBFS: a real microphone is never digital zero. */
function writeSilence(file: string, seconds: number) {
  const n = 48000 * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(96000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf.writeInt16LE(((seed >> 8) % 21) - 10, 44 + i * 2);
  }
  writeFileSync(file, buf);
}

/** CPU (% of one core) and memory (PSS, else RSS, MB) of the process tree under `root`. */
function treeUsage(prev: Snapshot, cur: Snapshot, root: number) {
  const seconds = (cur.t - prev.t) / 1000;
  let cpu = 0;
  let mem = 0;
  for (const pid of cur.tree(root)) {
    const before = prev.procs.get(pid);
    const now = cur.procs.get(pid)!;
    if (before) cpu += Math.max(0, ((now.cpuSec - before.cpuSec) / seconds) * 100);
    mem += now.pssMB ?? now.rssMB;
  }
  return { cpu, mem };
}

type AudioRead = { features: { playbackStats: boolean }; contexts: { id: number; playback?: { underrunEvents: number } }[] } | null;

/** Underrun events over the measured window; contexts created during it count from zero. */
function underrunsBetween(first: AudioRead, last: AudioRead) {
  if (!last?.features.playbackStats) return undefined;
  const before = (id: number) => first?.contexts.find((c) => c.id === id)?.playback?.underrunEvents ?? 0;
  return last.contexts.reduce((sum, c) => sum + (c.playback?.underrunEvents ?? 0) - before(c.id), 0);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const started = new Date();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'tt-perf-'));
  const speech = path.join(CLIENT_DIR, 'e2e', 'fixtures', 'speech-16k.wav');
  const silence = path.join(scratch, 'silence.wav');
  writeSilence(silence, 10);
  const electronBin = require(path.join(CLIENT_DIR, 'node_modules', 'electron')) as string;
  const cleanup: (() => Promise<unknown> | unknown)[] = [() => rmSync(scratch, { recursive: true, force: true })];

  try {
    console.log(`[perf] ${o.scenario}: ${o.clients} client(s), ${o.duration}s (+${o.warmup}s warmup)`);
    // Another stack on these ports would answer our requests.
    for (const port of [PORTS.api, PORTS.livekit, PORTS.rtcTcp, PORTS.web]) {
      await new Promise<void>((ok, fail) => {
        const srv = createServer();
        srv.once('error', () => fail(new Error(`port ${port} is in use: another stack is running`)));
        srv.listen(port, '0.0.0.0', () => srv.close(() => ok()));
      });
    }
    const stack = await startStack();
    cleanup.push(() => stack.stop());

    const ids: number[] = [];
    for (let i = 0; i < o.clients; i++) ids.push((await register(stack.api, 'perf' + i)).user.id);
    const group = await fetch(stack.api + '/api/v1/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await loginToken(stack.api, 'perf0')) },
      body: JSON.stringify({ name: 'Перф', members: ids.slice(1), room_name: 'Общая', channel_name: 'общий' }),
    });
    if (!group.ok) throw new Error('create group: ' + group.status);

    // Client 0 is measured. The first two send speech, the others faint noise.
    const clients: ElectronClient[] = [];
    for (let i = 0; i < o.clients; i++) {
      // Typing into the login form races with loading the saved server.
      const profile = mkdtempSync(path.join(scratch, 'profile-' + i + '-'));
      writeFileSync(path.join(profile, 'tolktak.json'), JSON.stringify({ server: stack.api, token: await loginToken(stack.api, 'perf' + i), minimizeToTray: true }));
      const mic = i < 2 ? speech : silence;
      const app = await launchElectron({
        electron: electronBin,
        app: CLIENT_DIR,
        args: ['--no-sandbox', '--lang=ru', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--no-proxy-server'],
        env: { TOLKTAK_USER_DATA: profile },
        port: PORTS.livekit + 320 + i * 2,
        initScript: PROBE_SCRIPT,
        onError: (m) => console.log(`[perf${i} pageerror]`, m),
      });
      cleanup.push(() => app.close().catch(() => {}));
      await app.page.waitFor('.shell', 60_000);
      clients.push(app);
    }
    const me = clients[0];

    const openGroup = (c: ElectronClient) => c.page.click('.rail-btn.group', 'ПЕ');
    if (o.scenario === 'idle-chat') await openGroup(me);
    if (o.scenario === 'voice') {
      for (const c of clients) {
        await openGroup(c);
        await c.page.click('.room-join', 'Общая');
        await c.page.waitFor('.voicebar-call .dot.ok', 60_000);
      }
    }
    if (o.scenario === 'idle-tray') await me.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    else if (o.window === 'back') await me.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
    else await me.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

    const sampler = makeSampler(() => clients.map((c) => c.pid));
    const readAudio = () => Promise.all(clients.map((c) => c.page.evaluate(() => (globalThis as any).__perfAudioRead?.() as AudioRead).catch(() => null)));

    console.log(`[perf] warmup ${o.warmup}s`);
    await sleep(o.warmup * 1000);
    const audioBefore = await readAudio();
    const usage = clients.map(() => ({ cpu: [] as number[], mem: [] as number[] }));
    let prev = sampler.snapshot();
    for (const end = Date.now() + o.duration * 1000; Date.now() < end; ) {
      await sleep(1000);
      const cur = sampler.snapshot();
      clients.forEach((c, i) => {
        const u = treeUsage(prev, cur, c.pid);
        usage[i].cpu.push(u.cpu);
        usage[i].mem.push(u.mem);
      });
      prev = cur;
    }
    const audioAfter = await readAudio();

    const metrics: Record<string, number | null> = {};
    clients.forEach((_c, i) => {
      metrics[`perf${i}.total.cpu.mean`] = mean(usage[i].cpu);
      metrics[`perf${i}.total.mem.mean`] = mean(usage[i].mem);
      const underruns = underrunsBetween(audioBefore[i], audioAfter[i]);
      if (underruns !== undefined) metrics[`perf${i}.audio.underrunEvents`] = underruns;
    });
    const cpus = os.cpus();
    const result = {
      schema: SCHEMA,
      scenario: o.scenario,
      label: o.label,
      params: { ...o, out: undefined },
      startedAt: started.toISOString(),
      host: { release: os.release(), cpuModel: cpus[0]?.model, logicalCpus: cpus.length, memGB: round(os.totalmem() / 2 ** 30, 1), note: process.env.PERF_HOST_NOTE },
      units: { cpu: '% of one core (100 = one full core), mean over the measured window', mem: 'MB, PSS' },
      metrics,
    };
    const file = o.out ?? path.join(REPO, 'perf', 'results', `${o.label ?? o.scenario}-${started.toISOString().replace(/[:.]/g, '-')}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(result, null, 1));
    console.log('[perf] wrote', file);
    console.log(JSON.stringify(metrics, null, 1));
  } finally {
    for (const f of cleanup.reverse()) {
      try {
        await f();
      } catch (e) {
        console.log('[perf] cleanup', String(e));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
