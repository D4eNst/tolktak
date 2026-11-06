import { chromium } from '@playwright/test';
import { transform } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { code } = await transform(readFileSync(new URL('../../src/sounds.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { SOUND_THEMES, SOUND_KINDS } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const periods = { 'tok-tak': 2.2, 'wood-low': 3.2, velvet: 2.4 };
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Sound renderer</title>'); }
  if (!['/wood.mjs', '/instruments.mjs'].includes(req.url)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end(readFileSync(new URL('.' + req.url, import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const theme of SOUND_THEMES) {
    const folder = new URL(`../../src/renderer/assets/sounds/${theme}/`, import.meta.url);
    mkdirSync(folder, { recursive: true });
    for (const event of SOUND_KINDS) {
      const encoded = await page.evaluate(async ({ theme, event, period }) => {
        const buffer = theme === 'wood-low'
          ? await (await import('/wood.mjs')).renderWood(event)
          : await (await import('/instruments.mjs')).renderInstrument(theme, event);
        const data = buffer.getChannelData(0);
        const length = event === 'ring' ? Math.round(period * buffer.sampleRate) : data.length;
        const bytes = new ArrayBuffer(44 + length * 2), v = new DataView(bytes);
        const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
        text(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
        text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, length * 2, true);
        for (let i = 0; i < length; i++) {
          if (!Number.isFinite(data[i]) || Math.abs(data[i]) > .361) throw new Error(`Invalid sample: ${theme}/${event}`);
          v.setInt16(44 + i * 2, Math.round(data[i] * 32767), true);
        }
        const view = new Uint8Array(bytes), chunks = [];
        for (let i = 0; i < view.length; i += 8192) chunks.push(String.fromCharCode(...view.subarray(i, i + 8192)));
        return btoa(chunks.join(''));
      }, { theme, event, period: periods[theme] });
      const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-application', 'audio', '-map_metadata', '-1', fileURLToPath(new URL(event + '.ogg', folder))], { input: Buffer.from(encoded, 'base64') });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.toString());
    }
  }
  console.log(`Generated ${SOUND_THEMES.length * SOUND_KINDS.length} interface sounds.`);
} finally {
  await browser?.close();
  server.close();
}
