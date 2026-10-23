// With SHOWCASE_DIR set it also saves screenshots.
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
let groupId = 0;
let mainChannel = 0;
const shots = process.env.SHOWCASE_DIR;

async function call(user: string, method: string, p: string, body?: unknown) {
  const r = await fetch(stack.api + '/api/v1' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[user] },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
async function upload(user: string, name: string, data: Buffer, type: string) {
  const r = await fetch(`${stack.api}/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tokens[user], 'Content-Type': type },
    body: new Uint8Array(data),
  });
  if (!r.ok) throw new Error('upload ' + r.status);
  return (await r.json()).file as { id: string };
}
const send = (user: string, cid: number, text: string, extra: Record<string, unknown> = {}) =>
  call(user, 'POST', `/channels/${cid}/messages`, { text, nonce: crypto.randomUUID(), ...extra }).then((r) => r.message as { id: number });

function wav(): Buffer {
  const rate = 16000;
  const n = rate * 1.5;
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
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * (i < n / 2 ? 220 : 330)) * 8000 * Math.sin((i / n) * Math.PI)), 44 + i * 2);
  return b;
}

async function snap(p: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await p.waitForTimeout(350);
  await p.screenshot({ path: path.join(shots, name + '.png') });
}

test.beforeAll(async ({ browser }) => {
  stack = await startStack();
  const people: [string, string, string][] = [
    ['alice', 'Алиса', '🍿 Смотрю кино'],
    ['bob', 'Борис', '🎮 Играю'],
    ['carol', 'Катя', ''],
    ['dima', 'Дима', '💻 Работаю'],
  ];
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  const draw = async (w: number, h: number, css: string, content: string) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<body style="margin:0"><div style="width:${w}px;height:${h}px;display:grid;place-items:center;font:700 ${Math.round(h / 2.2)}px sans-serif;color:#fff;${css}">${content}</div>`);
    return page.screenshot();
  };
  for (const [u, name, status] of people) {
    const r = await register(stack.api, u);
    ids[u] = r.user.id;
    tokens[u] = await loginToken(stack.api, u);
    await call(u, 'PATCH', '/me', { display_name: name, status, about: u === 'bob' ? 'Собираю всех на кино по пятницам. Пишите в личку!' : '' });
  }
  for (const [u, css, emoji] of [
    ['bob', 'background:linear-gradient(135deg,#5b8cff,#b48cff)', '🦊'],
    ['dima', 'background:linear-gradient(135deg,#4fd69c,#2f8f6b)', '🐼'],
  ] as const) {
    const f = await upload(u, 'avatar.png', await draw(128, 128, css, emoji), 'image/png');
    await call(u, 'PATCH', '/me', { avatar: f.id });
  }
  const g = (await call('alice', 'POST', '/groups', { name: 'Киноклуб', members: [ids.bob, ids.carol, ids.dima], room_name: 'Общая', channel_name: 'общий' })).group;
  groupId = g.id;
  mainChannel = g.channel_id;
  const cover = await upload('alice', 'cover.png', await draw(128, 128, 'background:linear-gradient(135deg,#ff6a63,#ffbe4b)', '🍿'), 'image/png');
  await call('alice', 'PATCH', `/groups/${groupId}`, { avatar: cover.id, description: 'Смотрим кино по пятницам, обсуждаем без спойлеров.' });
  await call('alice', 'PUT', `/groups/${groupId}/members/${ids.bob}/role`, { role: 'mod' });
  await call('bob', 'POST', `/groups/${groupId}/channels`, { name: 'мемы' });

  const m1 = await send('bob', mainChannel, 'Всем привет! В пятницу в **21:00** смотрим *Интерстеллар* 🍿\nКто с нами?');
  await send('carol', mainChannel, 'Я в деле! ||Только без спойлеров про финал||', { reply_to: m1.id });
  const poster = await upload('dima', 'poster.png', await draw(400, 240, 'background:radial-gradient(circle at 30% 30%,#ffbe4b,#ff6a63 40%,#3a1630 80%)', '🪐'), 'image/png');
  await send('dima', mainChannel, 'Нашёл постер для анонса', { attachments: [poster.id] });
  const voice = await upload('dima', 'voice-2026-10-22.wav', wav(), 'audio/wav');
  await send('dima', mainChannel, '', { attachments: [voice.id] });
  const m5 = await send('bob', mainChannel, '> Кто с нами?\nСсылка на сервер: https://talk.d4enst.ru\nУстановщик: `TolkTak-Setup.exe`');
  await call('alice', 'POST', `/messages/${m5.id}/pin`);
  for (const [u, e] of [
    ['alice', '🔥'],
    ['carol', '🔥'],
    ['dima', '🔥'],
    ['carol', '❤️'],
  ])
    await call(u, 'POST', `/messages/${m1.id}/reactions`, { emoji: e });
  await send('carol', mainChannel, '[[sticker:popcorn]]');
  const dm = (await call('bob', 'POST', '/dms', { user_id: ids.alice })).channel;
  await send('bob', dm.id, 'Привет! Захватишь колонки? 🔊');
  await send('alice', dm.id, 'Конечно, и пледы 😄');
  await page.close();
});
test.afterAll(async () => stack?.stop());

test('chat, groups and profiles in the desktop client', async ({ browser }) => {
  test.skip(!process.env.DISPLAY, 'needs an X display (xvfb-run)');
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), '--no-sandbox', '--lang=ru', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server'],
    env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(tmpdir(), 'tt-chat-')) } as Record<string, string>,
  });
  const w = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  w.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await expect(w.locator('.login-card')).toBeVisible();
  await snap(w, '01-login');
  await w.fill('input[name=server]', stack.api);
  await w.fill('input[name=username]', 'alice');
  await w.fill('input[name=password]', 'password123');
  await w.click('button[type=submit]');
  await expect(w.locator('.shell')).toBeVisible();
  await snap(w, '02-home');

  await w.locator('.rail-btn.group').first().click();
  await expect(w.locator('.msg-text strong', { hasText: '21:00' })).toBeVisible();
  await expect(w.locator('.msg-reply', { hasText: 'Борис' })).toBeVisible();
  await expect(w.locator('.spoiler')).toBeVisible();
  await expect(w.locator('.img-att img')).toBeVisible();
  await expect(w.locator('.audio-att.voice')).toBeVisible();
  await expect(w.locator('.reaction', { hasText: '🔥' }).locator('.reaction-n')).toHaveText('3');
  await expect(w.locator('.sticker')).toBeVisible();
  await expect(w.locator('.msg-text a', { hasText: 'talk.d4enst.ru' })).toBeVisible();
  await expect(w.locator('.member')).toHaveCount(4);
  await expect(w.locator('.side-item.channel')).toHaveCount(2);
  await snap(w, '03-group-chat');

  await w.locator('.reaction', { hasText: '❤️' }).click();
  await expect(w.locator('.reaction.mine', { hasText: '❤️' }).locator('.reaction-n')).toHaveText('2');

  const first = w.locator('.msg', { hasText: 'Интерстеллар' }).first();
  await first.hover();
  await snap(w, '04-hover-toolbar');
  await first.locator('.msg-actions button[aria-label="Ответить"]').click();
  await expect(w.locator('.reply-bar')).toContainText('Борис');
  await w.locator('.composer input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('список фильмов') });
  await expect(w.locator('.upload')).toHaveCount(1);
  await w.locator('.composer textarea').fill('Беру ~~попкорн~~ **начос**, @dima с тебя пледы');
  await snap(w, '05-composer-reply');
  await w.keyboard.press('Enter');
  const mine = w.locator('.msg', { hasText: 'начос' });
  await expect(mine.locator('s', { hasText: 'попкорн' })).toBeVisible();
  await expect(mine.locator('.mention', { hasText: 'Дима' })).toBeVisible();
  await expect(mine.locator('.msg-reply')).toContainText('Борис');
  await expect(mine.locator('.file-att', { hasText: 'notes.txt' })).toBeVisible();

  await w.locator('.composer button[aria-label="Эмодзи"]').click();
  await expect(w.locator('.emoji-pop')).toBeVisible();
  await snap(w, '06-emoji');
  await w.locator('.emoji-tabs .sticker-tab').click();
  await snap(w, '07-stickers');
  await w.keyboard.press('Escape');

  await first.click({ button: 'right' });
  await expect(w.locator('.menu')).toBeVisible();
  await snap(w, '08-context-menu');
  await w.keyboard.press('Escape');
  await w.locator('button[aria-label="Закреплённые"]').click();
  await expect(w.locator('.chat-panel .mini-msg')).toHaveCount(1);
  await snap(w, '09-pins');
  await w.locator('button[aria-label="Поиск по чату"]').click();
  await w.locator('.chat-panel input').fill('постер');
  await expect(w.locator('.chat-panel .mini-msg')).toHaveCount(1);
  await w.locator('.chat-panel button[aria-label="Закрыть"]').click();

  await w.locator('.msg-author', { hasText: 'Борис' }).first().click();
  await expect(w.locator('.profile-card .profile-name')).toHaveText('Борис');
  await snap(w, '10-profile');
  await w.locator('.profile-username').click();
  await expect(w.locator('.toast', { hasText: 'Логин скопирован' })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('bob');
  await w.keyboard.press('Escape');

  await w.locator('.group-title').click();
  await w.locator('.menu button', { hasText: 'Настройки группы' }).click();
  await w.locator('.settings-nav button', { hasText: 'Участники' }).click();
  await expect(w.locator('.role-chip.role-mod')).toHaveCount(1);
  await snap(w, '11-group-settings');
  await w.locator('.modal header button[aria-label="Закрыть"]').click();
  await expect(w.locator('.modal')).toHaveCount(0);

  await w.locator('.group-title').click();
  await w.locator('.menu button', { hasText: 'Удалить группу' }).click();
  await expect(w.locator('.modal.ask')).toBeVisible();
  await snap(w, '12-confirm');
  await w.locator('.modal.ask button', { hasText: 'Отмена' }).click();

  await w.locator('.self-panel button[aria-label="Микрофон"]').click();
  await expect(w.locator('.self-panel button[aria-label="Микрофон"]')).toHaveClass(/off/);
  await w.locator('.self-panel button[aria-label="Звук"]').click();
  await expect(w.locator('.self-panel button[aria-label="Звук"]')).toHaveClass(/off/);
  await w.locator('.self-panel button[aria-label="Звук"]').click();
  await w.locator('.self-panel button[aria-label="Микрофон"]').click();
  await expect(w.locator('.self-panel button[aria-label="Микрофон"]')).not.toHaveClass(/off/);

  await w.locator('.self-panel button[aria-label="Настройки"]').click();
  await snap(w, '13-settings-voice');
  await w.locator('.segmented button', { hasText: 'Рация' }).click();
  await expect(w.locator('.key-capture')).toBeVisible();
  await w.locator('.key-capture').click();
  await w.keyboard.press('F8');
  await expect(w.locator('.key-capture')).toHaveText('F8');
  await w.locator('.settings-nav button', { hasText: 'Горячие клавиши' }).click();
  await snap(w, '14-settings-keys');
  await w.locator('.settings-nav button', { hasText: 'Профиль' }).click();
  await snap(w, '15-settings-profile');
  await w.locator('.settings-nav button', { hasText: 'Голос' }).click();
  await w.locator('.segmented button', { hasText: 'По голосу' }).click();
  await w.keyboard.press('Escape');

  await w.locator('.side-item.channel', { hasText: 'мемы' }).click();
  await expect(w.locator('.main-head h1')).toHaveText('мемы');
  await w.keyboard.press('Control+k');
  await expect(w.locator('.switcher')).toBeVisible();
  await w.locator('.switcher input').fill('бор');
  await snap(w, '16-switcher');
  await w.keyboard.press('Enter');
  await expect(w.locator('.main-head h1')).toHaveText('Борис');
  await snap(w, '17-dm');

  await w.locator('.rail-btn.group').first().click();
  await w.locator('.room-join', { hasText: 'Общая' }).click();
  await expect(w.locator('.voicebar-call .dot.ok')).toBeVisible();
  const bob = await openClient(browser, stack, 'bob');
  await bob.locator('.rail-btn.group').first().click();
  await bob.locator('.room-join', { hasText: 'Общая' }).click();
  await expect(w.locator('.tile')).toHaveCount(2);
  await snap(w, '18-voice');
  await bob.click('button[aria-label="Демонстрация"]');
  await bob.locator('.warn-box input[type=checkbox]').check();
  await bob.click('.modal button.primary');
  await w.locator('.stream-card').click();
  await expect(w.locator('.theater')).toBeVisible();
  await w.waitForTimeout(2500);
  await w.locator('.theater-video').hover();
  await w.locator('.reaction-toggle').click();
  await w.locator('.reaction-bar button').first().click();
  await expect(bob.locator('.floater')).toHaveCount(1);
  await snap(w, '19-theater');
  await bob.context().close();
  await app.close();
  if (shots) writeFileSync(path.join(shots, 'README.txt'), 'Screenshots from e2e/chat.spec.ts (Electron under Xvfb, fake camera/screen).\n');
});
