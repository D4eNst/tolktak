// By hand on a Windows PC: start-stack.ps1, then TT_API=http://<lan-ip>:8080.
// Playwright's Electron loader drops --enable-features unless legacy screenshots are on.
process.env.PLAYWRIGHT_LEGACY_SCREENSHOT = '1';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const API = process.env.TT_API ?? '';
const ROOT = path.join(__dirname, '..');
const work = mkdtempSync(path.join(tmpdir(), 'tt-win-'));
const VOICE_HZ = 440; // Bob's voice
const MOVIE_HZ = 1500; // the shared app's sound

function wav(file: string, hz: number, seconds: number) {
  const rate = 48000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  writeFileSync(file, b);
  return file;
}

async function api(pathname: string, body?: unknown, token?: string) {
  const r = await fetch(API + '/api/v1' + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function launch(user: string, micWav?: string): Promise<{ app: ElectronApplication; w: Page }> {
  // No fake-media switches for the sharer: they bypass the display-media handler.
  const app = await electron.launch({
    args: micWav
      ? [ROOT, '--lang=ru', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micWav}`]
      : [ROOT, '--lang=ru', ...(process.env.TT_ALICE_FLAGS ? process.env.TT_ALICE_FLAGS.split(' ') : [])],
    env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(work, user + '-')) } as Record<string, string>,
  });
  const log: string[] = [];
  app.process().stdout?.on('data', (d) => log.push(String(d)));
  app.process().stderr?.on('data', (d) => log.push(String(d)));
  (app as any).__log = log;
  const w = await app.firstWindow();
  // Noise suppression would remove a steady tone, and UI sounds would add one.
  await w.evaluate((raw) => localStorage.setItem('tolktak.voice', JSON.stringify(raw ? { sounds: false, noiseSuppression: false, echoCancellation: false, autoGainControl: false } : { sounds: false })), !!micWav);
  await w.reload();
  await w.fill('input[name=server]', API);
  await w.fill('input[name=username]', user);
  await w.fill('input[name=password]', 'password123');
  await w.click('button[type=submit]');
  await expect(w.locator('.shell')).toBeVisible();
  return { app, w };
}

async function streamSpectrum(bob: Page, fromIdentity: string) {
  return bob.evaluate(
    async ({ from, voice, movie }) => {
      const room = (globalThis as any).__tolktak.room;
      const p = room.remoteParticipants.get(from);
      const pub = p && [...p.trackPublications.values()].find((t: any) => t.source === 'screen_share_audio');
      const mst: MediaStreamTrack | undefined = pub?.track?.mediaStreamTrack;
      if (!mst) return null;
      const ms = new MediaStream([mst]);
      const el = new Audio();
      el.srcObject = ms; // remote audio reaches WebAudio only while attached
      el.muted = true;
      await el.play().catch(() => {});
      const ctx = new AudioContext({ sampleRate: 48000 });
      const an = ctx.createAnalyser();
      an.fftSize = 16384;
      ctx.createMediaStreamSource(ms).connect(an);
      const buf = new Float32Array(an.frequencyBinCount);
      const acc = new Float32Array(an.frequencyBinCount).fill(-200);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        an.getFloatFrequencyData(buf);
        for (let k = 0; k < buf.length; k++) acc[k] = Math.max(acc[k], buf[k]);
      }
      const bin = (hz: number) => Math.round((hz / 24000) * an.frequencyBinCount);
      const peak = (hz: number) => Math.max(...[-2, -1, 0, 1, 2].map((d) => acc[bin(hz) + d]));
      const floor = [...acc].sort((a, b) => a - b)[Math.floor(acc.length / 2)];
      await ctx.close();
      el.srcObject = null;
      return { voice_dB: +peak(voice).toFixed(1), movie_dB: +peak(movie).toFixed(1), floor_dB: +floor.toFixed(1) };
    },
    { from: fromIdentity, voice: VOICE_HZ, movie: MOVIE_HZ },
  );
}

test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'win32' || !API, 'Windows PC with TT_API only');

test('stream sound: app/system capture exclude room voices; plain loopback echoes', async () => {
  test.setTimeout(300_000);
  const users: Record<string, { id: number; token: string }> = {};
  for (const u of ['winalice', 'winbob']) {
    await api('/auth/register', { username: u, display_name: u, password: 'password123' });
    const r = await api('/auth/login', { username: u, password: 'password123', device: 'win-e2e' });
    users[u] = { id: r.user.id, token: r.token };
  }
  await api('/groups', { name: 'WinTest', members: [users.winbob.id], room_name: 'Общая', channel_name: 'общий' }, users.winalice.token);

  const movieWav = wav(path.join(work, 'movie.wav'), MOVIE_HZ, 5);
  const movie: ChildProcess = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $p = New-Object System.Media.SoundPlayer '${movieWav}'; $p.PlayLooping(); ` +
        `$f = New-Object System.Windows.Forms.Form; $f.Text = 'TolkTak Movie'; $f.Width = 1281; $f.Height = 721; $f.BackColor = 'DarkBlue'; [void]$f.ShowDialog()`,
    ],
    { stdio: 'ignore' },
  );
  const results: Record<string, unknown> = {};
  let alice: { app: ElectronApplication; w: Page } | undefined;
  let bob: { app: ElectronApplication; w: Page } | undefined;
  try {
    alice = await launch('winalice');
    bob = await launch('winbob', wav(path.join(work, 'voice.wav'), VOICE_HZ, 5));
    for (const p of [alice.w, bob.w]) {
      await p.locator('.rail-btn.group').first().click();
      await p.locator('.room-join').first().click();
      await expect(p.locator('.voicebar-call .dot.ok')).toBeVisible();
    }
    await expect(alice.w.locator('.tile')).toHaveCount(2);
    // Alice's microphone would hear the speakers.
    if (await alice.w.locator('.call-controls button[aria-label="Микрофон"].off').count() === 0) await alice.w.click('.call-controls button[aria-label="Микрофон"]');
    results.appInfo = await alice.w.evaluate(() => (window as any).tolktak.appInfo());

    await alice.w.waitForTimeout(3000);
    results.aliceHearsBob = (await alice.w.evaluate(() => (globalThis as any).__tolktak.stats())).inbound.filter((x: any) => x.source === 'microphone');
    results.encoderProbe = await alice.w.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const types = [
        'video/h264;profile-level-id=42e01f',
        'video/h264;profile-level-id=42e034',
        'video/h264;profile-level-id=4d0034',
        'video/h264;profile-level-id=640034',
        'video/VP9',
        'video/AV1',
      ];
      for (const t of types)
        for (const [w, h] of [[1280, 720], [1920, 1080]]) {
          try {
            const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: t, width: w, height: h, bitrate: 6e6, framerate: 60 } } as any);
            out[`${t} ${w}x${h}`] = `${r.supported ? 'ok' : 'no'}${r.powerEfficient ? ' HW' : ' SW'}`;
          } catch (e) {
            out[`${t} ${w}x${h}`] = String(e);
          }
        }
      return out;
    });
    const sources = await alice.w.evaluate(() => (window as any).tolktak.captureSources());
    const movieWin = sources.find((s: any) => s.kind === 'window' && s.name === 'TolkTak Movie');
    const screen = sources.find((s: any) => s.kind === 'screen');
    expect(movieWin, 'movie window visible to the picker').toBeTruthy();

    const cases: [string, any, string][] = [
      ['screen-video-only', screen, 'none'],
      ['window-video-only', movieWin, 'none'],
      ['system', screen, 'system'],
      ['app', movieWin, 'app'],
      ['system-all (baseline, expected echo)', screen, 'system-all'],
      ['system-single-layer', screen, 'system'],
    ];
    for (const [name, src, audio] of cases) {
      const entry: Record<string, unknown> = {};
      results[name] = entry;
      try {
        await alice.w.evaluate(
          async ({ id, name, audio, single }) =>
            (globalThis as any).__tolktak.share({ sourceId: id, sourceName: name, audio, mode: 'motion', quality: '1080p60', singleLayer: single }),
          { id: src.id, name: src.name, audio, single: name.includes('single') },
        );
        entry.audioInfo = await alice.w.evaluate(() => (window as any).tolktak.lastCaptureAudio());
        await bob.w.locator('.stream-card').first().click();
        // percentCPUUsage covers the time since the previous call.
        await alice.app.evaluate(({ app }) => app.getAppMetrics());
        await bob.w.waitForTimeout(5000);
        entry.aliceCpu = await alice.app.evaluate(({ app }) => {
          const m = app.getAppMetrics();
          const by: Record<string, number> = {};
          for (const x of m) by[x.type] = +((by[x.type] ?? 0) + x.cpu.percentCPUUsage).toFixed(1);
          return { total: +m.reduce((a, x) => a + x.cpu.percentCPUUsage, 0).toFixed(1), by };
        });
        if (audio !== 'none') entry.spectrum = await streamSpectrum(bob.w, String(users.winalice.id));
        entry.encoder = (await alice.w.evaluate(() => (globalThis as any).__tolktak.stats())).outbound.filter((o: any) => o.source === 'screen_share' && o.width);
        entry.hw = (entry.encoder as any[]).map((o) => `${o.width}x${o.height}@${o.fps} ${o.encoder} pe=${o.powerEfficient} ${o.codec}`);
        await bob.w.locator('.theater button', { hasText: 'Закрыть' }).click();
      } catch (e) {
        entry.error = String((e as Error).message).slice(0, 500);
        entry.audioInfo = await alice.w.evaluate(() => (window as any).tolktak.lastCaptureAudio()).catch(() => null);
      }
      await alice.w.evaluate(() => (globalThis as any).__tolktak.stopShare()).catch(() => {});
      await alice.w.waitForTimeout(1500);
    }
    results.metrics = {
      alice: await alice.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, memMB: Math.round(m.memory.workingSetSize / 1024) }))),
    };
  } finally {
    results.aliceMainLog = ((alice?.app as any)?.__log ?? []).join('').slice(-4000);
    test.info().annotations.push({ type: 'windows', description: JSON.stringify(results, null, 1) });
    console.log(JSON.stringify(results, null, 1));
    writeFileSync(path.join(process.env.TT_RESULTS_DIR ?? ROOT, 'windows-results.json'), JSON.stringify(results, null, 1));
    await alice?.app.close();
    await bob?.app.close();
    movie.kill();
  }
  const r = results as any;
  const base = r['system-all (baseline, expected echo)']?.spectrum;
  r.echoBaseline = base;
  // Without the echo in the baseline the leak check proves nothing.
  expect.soft(base && base.voice_dB - base.floor_dB, 'baseline: voice audible in plain loopback').toBeGreaterThan(20);
  for (const k of ['app', 'system']) {
    expect.soft(r[k].error, `${k}: capture started`).toBeUndefined();
    if (!r[k].spectrum || !base) continue;
    expect.soft(r[k].spectrum.movie_dB - r[k].spectrum.floor_dB, `${k}: movie sound present`).toBeGreaterThan(10);
    expect.soft(base.voice_dB - r[k].spectrum.voice_dB, `${k}: voice at least 20 dB below the echo baseline`).toBeGreaterThan(20);
  }
});

test('gpu / hardware encoder probe', async () => {
  test.setTimeout(240_000);
  const variants: Record<string, string[]> = {
    default: [],
    'ignore-gpu-blocklist': ['--ignore-gpu-blocklist'],
    'mf-h264-feature': ['--enable-features=MediaFoundationH264Encoding'],
    'both': ['--ignore-gpu-blocklist', '--enable-features=MediaFoundationH264Encoding'],
  };
  const out: Record<string, unknown> = {};
  for (const [name, flags] of Object.entries(variants)) {
    const app = await electron.launch({ args: [ROOT, ...flags], env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(work, 'gpu-')) } as Record<string, string> });
    try {
      const w = await app.firstWindow();
      await w.waitForTimeout(1500);
      const feature = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
      const info: any = await app.evaluate(({ app }) => app.getGPUInfo('complete'));
      const probe = await w.evaluate(async () => {
        const r: Record<string, string> = {};
        for (const t of ['video/h264;profile-level-id=42e01f', 'video/h264;profile-level-id=640034', 'video/AV1', 'video/VP9']) {
          const x = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: t, width: 1920, height: 1080, bitrate: 6e6, framerate: 60 } } as any);
          r[t] = `${x.supported ? 'ok' : 'no'}${x.powerEfficient ? ' HW' : ' SW'}`;
        }
        return r;
      });
      const gpuPage: string = await app.evaluate(async ({ BrowserWindow }) => {
        const b = new BrowserWindow({ show: false });
        await b.loadURL('chrome://gpu');
        await new Promise((r) => setTimeout(r, 4000));
        const text = await b.webContents.executeJavaScript(
          "(() => { const v = document.querySelector('info-view'); return (v && v.shadowRoot ? v.shadowRoot.textContent : document.body.innerText) || ''; })()",
        );
        b.destroy();
        return String(text);
      });
      const i = gpuPage.indexOf('Video Acceleration');
      const webcodecs = await w.evaluate(async () => {
        const r: Record<string, string> = {};
        for (const codec of ['avc1.42e01f', 'avc1.640028', 'av01.0.08M.08', 'vp09.00.40.08'])
          for (const hw of ['prefer-hardware', 'prefer-software']) {
            try {
              const x = await (window as any).VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 6e6, framerate: 60, hardwareAcceleration: hw });
              r[`${codec} ${hw}`] = x.supported ? 'yes' : 'no';
            } catch (e) {
              r[`${codec} ${hw}`] = String(e).slice(0, 80);
            }
          }
        return r;
      });
      out[name] = {
        videoAcceleration: i >= 0 ? gpuPage.slice(i, i + 2500) : gpuPage.slice(0, 1500),
        driverBugWorkarounds: (() => { const j = gpuPage.indexOf('Driver Bug Workarounds'); return j >= 0 ? gpuPage.slice(j, j + 1200) : ''; })(),
        webcodecs,
        auxAttributes: info?.auxAttributes,
        feature: { video_encode: (feature as any).video_encode, video_decode: (feature as any).video_decode, gpu_compositing: (feature as any).gpu_compositing },
        gpu: (info?.gpuDevice ?? []).map((d: any) => `${d.vendorString ?? d.vendorId} ${d.deviceString ?? d.deviceId} active=${d.active}`),
        encodeProfiles: (info?.videoEncodeAcceleratorSupportedProfile ?? info?.videoEncoderSupportedProfile ?? []).map((p: any) => `${p.profile} ${p.maxResolutionWidth ?? ''}x${p.maxResolutionHeight ?? ''}`).slice(0, 20),
        infoKeys: Object.keys(info ?? {}).slice(0, 40),
        webrtc: probe,
      };
    } catch (e) {
      out[name] = { error: String(e).slice(0, 300) };
    } finally {
      await app.close();
    }
  }
  console.log(JSON.stringify(out, null, 1));
  writeFileSync(path.join(process.env.TT_RESULTS_DIR ?? ROOT, 'gpu-results.json'), JSON.stringify(out, null, 1));
});

test('webrtc hardware encode in a real call', async () => {
  test.setTimeout(300_000);
  const variants: Record<string, string[]> = {
    default: [],
    'cbp-feature': ['--enable-features=PlatformH264CbpEncoding'],
  };
  const out: Record<string, unknown> = {};
  for (const [name, flags] of Object.entries(variants)) {
    const app = await electron.launch({ args: [ROOT, ...flags], env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(work, 'hw-')) } as Record<string, string> });
    try {
      const w = await app.firstWindow();
      await w.waitForTimeout(1500);
      out[name] = await w.evaluate(async () => {
        const res: Record<string, unknown> = {};
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d')!;
        let f = 0;
        const timer = setInterval(() => {
          f++;
          g.fillStyle = `hsl(${(f * 7) % 360} 70% 50%)`;
          g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#fff';
          for (let i = 0; i < 40; i++) g.fillRect((f * 13 + i * 97) % 1280, (i * 53 + f * 5) % 720, 60, 60);
        }, 33);
        const stream = (canvas as any).captureStream(30) as MediaStream;
        const all = RTCRtpSender.getCapabilities('video')!.codecs;
        res.sendCodecs = [...new Set(all.map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`.trim()))];
        const cases: Record<string, (c: RTCRtpCodec) => boolean> = {
          'H264 CBP 42e01f': (c) => /h264/i.test(c.mimeType) && /profile-level-id=42e0/.test(c.sdpFmtpLine ?? ''),
          'H264 baseline 4200': (c) => /h264/i.test(c.mimeType) && /profile-level-id=4200/.test(c.sdpFmtpLine ?? ''),
          'H264 main 4d': (c) => /h264/i.test(c.mimeType) && /profile-level-id=4d/.test(c.sdpFmtpLine ?? ''),
          'H264 high 64': (c) => /h264/i.test(c.mimeType) && /profile-level-id=64/.test(c.sdpFmtpLine ?? ''),
          AV1: (c) => /av1/i.test(c.mimeType),
          VP9: (c) => /vp9/i.test(c.mimeType),
          VP8: (c) => /vp8/i.test(c.mimeType),
        };
        for (const [label, pick] of Object.entries(cases)) {
          const codecs = all.filter((c) => pick(c) || /rtx/i.test(c.mimeType));
          if (!codecs.some(pick)) {
            res[label] = 'not offered';
            continue;
          }
          const a = new RTCPeerConnection();
          const b = new RTCPeerConnection();
          a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
          b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
          try {
            const tr = a.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
            tr.setCodecPreferences(codecs);
            await a.setLocalDescription();
            await b.setRemoteDescription(a.localDescription!);
            await b.setLocalDescription();
            await a.setRemoteDescription(b.localDescription!);
            const p = tr.sender.getParameters();
            p.encodings[0].maxBitrate = 4_000_000;
            await tr.sender.setParameters(p);
            await new Promise((r) => setTimeout(r, 10000));
            const st = await a.getStats();
            let o: any = null;
            let codec = '';
            st.forEach((s: any) => {
              if (s.type === 'outbound-rtp' && s.kind === 'video') o = s;
            });
            if (o?.codecId) codec = (st.get(o.codecId) as any)?.mimeType + ' ' + ((st.get(o.codecId) as any)?.sdpFmtpLine ?? '');
            res[label] = o
              ? {
                  codec,
                  encoder: o.encoderImplementation,
                  powerEfficient: o.powerEfficientEncoder,
                  frames: o.framesEncoded,
                  fps: o.framesPerSecond,
                  size: `${o.frameWidth}x${o.frameHeight}`,
                  msPerFrame: o.framesEncoded ? +((o.totalEncodeTime * 1000) / o.framesEncoded).toFixed(2) : null,
                  limit: o.qualityLimitationReason,
                }
              : 'no outbound-rtp';
          } catch (e) {
            res[label] = 'error: ' + String(e).slice(0, 200);
          } finally {
            a.close();
            b.close();
          }
        }
        clearInterval(timer);
        const wc: Record<string, unknown> = {};
        const big = new OffscreenCanvas(1920, 1080);
        const bg = big.getContext('2d')!;
        for (const codec of ['avc1.640028', 'av01.0.08M.08'])
          for (const hw of ['prefer-hardware', 'prefer-software']) {
            try {
              let n = 0;
              let err = '';
              const enc = new (window as any).VideoEncoder({ output: () => n++, error: (e: any) => (err = String(e)) });
              enc.configure({ codec, width: 1920, height: 1080, bitrate: 6e6, framerate: 60, hardwareAcceleration: hw, latencyMode: 'realtime', ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}) });
              const t0 = performance.now();
              for (let i = 0; i < 120; i++) {
                bg.fillStyle = `hsl(${(i * 9) % 360} 70% 50%)`;
                bg.fillRect(0, 0, 1920, 1080);
                bg.fillStyle = '#fff';
                bg.fillRect((i * 31) % 1800, (i * 17) % 1000, 120, 80);
                const frame = new VideoFrame(big, { timestamp: (i * 1e6) / 60 });
                enc.encode(frame, { keyFrame: i === 0 });
                frame.close();
              }
              await enc.flush();
              wc[`${codec} ${hw}`] = { chunks: n, msPerFrame: +((performance.now() - t0) / 120).toFixed(2), err };
              enc.close();
            } catch (e) {
              wc[`${codec} ${hw}`] = 'error: ' + String(e).slice(0, 200);
            }
          }
        res.webcodecs = wc;
        return res;
      });
    } catch (e) {
      out[name] = { error: String(e).slice(0, 300) };
    } finally {
      await app.close();
    }
  }
  console.log(JSON.stringify(out, null, 1));
  writeFileSync(path.join(process.env.TT_RESULTS_DIR ?? ROOT, 'hw-results.json'), JSON.stringify(out, null, 1));
});
