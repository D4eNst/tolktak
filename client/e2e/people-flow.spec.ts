import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
let aliceToken: string;
let seeded: { id: number; username: string; display_name: string }[];
const root = path.resolve(__dirname, '../..');

async function api(method: string, endpoint: string, body?: unknown) {
  const response = await fetch(stack.api + '/api/v1' + endpoint, {
    method, headers: { Authorization: 'Bearer ' + aliceToken, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function people(page: Page) {
  await page.locator('.nav-tabs').getByRole('tab', { name: 'Люди', exact: true }).click();
  return page.locator('.navigator');
}

async function search(page: Page, query: string) {
  await people(page);
  await page.locator('.people-tabs').getByRole('tab', { name: 'Все', exact: true }).click();
  await page.locator('.nav-search input').fill(query);
}

async function signIn(page: Page, username: string) {
  const form = page.locator('.login-card');
  await expect(form).toBeVisible();
  await form.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
  await page.fill('input[name=server]', stack.api);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.locator('button[type=submit]').click();
  await expect(page.locator('.shell')).toBeVisible();
}

test.beforeEach(async () => {
  stack = await startStack();
  await register(stack.api, 'alice');
  await register(stack.api, 'bob');
  aliceToken = await loginToken(stack.api, 'alice');
  const python = path.join(root, 'server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  seeded = JSON.parse(execFileSync(python, ['-c', `
import asyncio, json, sys
from pathlib import Path
from tolktak import db
from tolktak.models import User
from tolktak.store import now
async def run():
    directory = Path(sys.argv[1]).resolve()
    assert directory.name.startswith('tolktak-e2e-') and (directory / 'tolktak.db').is_file()
    await db.init('', directory)
    template = await User.get(username='alice')
    created = []
    special = {117: 'Straße Ωμέγα', 118: 'Символы 100%_literal', 119: 'Елена Кириллица'}
    for n in range(1, 131):
        username = f'person{n:03d}'
        display = special.get(n, f'Участник {n:03d}')
        item = await User.create(username=username, display_name=display, password_hash=template.password_hash,
            username_folded=username.casefold(), display_name_folded=display.casefold(),
            color='#0090ff', is_admin=0, created_at=now())
        created.append({'id': item.id, 'username': username, 'display_name': display})
    print(json.dumps(created))
    await db.close()
asyncio.run(run())
`, stack.dataDir], { cwd: path.join(root, 'server'), encoding: 'utf8' }));
});
test.afterEach(async () => stack?.stop());

test('All stays empty until search, loads further pages on scroll and renders a bounded window', async ({ browser }) => {
  const requests: URL[] = [];
  const page = await openClient(browser, stack, 'alice', 'password123', (page) => {
    page.on('request', (request) => requests.push(new URL(request.url())));
  });
  try {
    const nav = await people(page);
    await expect(nav.getByText('Нет диалогов', { exact: true })).toBeVisible();
    await nav.locator('.people-tabs').getByRole('tab', { name: 'Все', exact: true }).click();
    await expect(nav.getByText('Введите имя или логин', { exact: true })).toBeVisible();
    expect(requests.filter((url) => url.pathname === '/api/v1/users/directory')).toHaveLength(0);
    await search(page, 'person');
    await expect(nav.locator('.nav-person-name').first()).toHaveText('Участник 001');
    const scroll = nav.locator('.people-scroll');
    for (const after of [50, 100]) {
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => requests.filter((url) => url.pathname === '/api/v1/users/directory' && Number(url.searchParams.get('after')) >= after).length).toBeGreaterThan(0);
      await expect(scroll.locator('.people-loading')).toHaveCount(0);
    }
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(nav.locator('.nav-person-name').last()).toHaveText('Участник 130');
    expect(await nav.locator('.nav-person').count()).toBeLessThan(40);
    const bottomRow = nav.locator('.nav-person-item', { hasText: 'Участник 130' });
    const position = await scroll.evaluate((element) => element.scrollTop);
    const searchesBeforeAction = requests.filter((url) => url.pathname === '/api/v1/users/directory').length;
    await bottomRow.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
    await expect(bottomRow.getByRole('button', { name: 'Отменить заявку', exact: true })).toBeEnabled();
    expect(Math.abs(await scroll.evaluate((element) => element.scrollTop) - position)).toBeLessThan(2);
    expect(requests.filter((url) => url.pathname === '/api/v1/users/directory')).toHaveLength(searchesBeforeAction);
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await expect(nav.locator('.nav-person-name').first()).toHaveText('Участник 001');
    for (const [query, name] of [['STRASSE', 'Straße Ωμέγα'], ['ЕЛЕНА', 'Елена Кириллица'], ['%_', 'Символы 100%_literal']]) {
      await search(page, query);
      await expect(nav.locator('.nav-person')).toHaveCount(1);
      await expect(nav.locator('.nav-person-name')).toHaveText(name);
    }
    await page.locator('.nav-search input').fill('');
    await expect(nav.locator('.nav-person')).toHaveCount(0);
    await expect(nav.getByText('Введите имя или логин', { exact: true })).toBeVisible();
    expect(requests.filter((url) => url.pathname === '/api/v1/users')).toHaveLength(0);
    const directory = requests.filter((url) => url.pathname === '/api/v1/users/directory');
    expect(directory.every((url) => url.searchParams.get('q') && Number(url.searchParams.get('limit')) <= 50)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('people-all-empty.png'), animations: 'disabled' });
  } finally { await page.context().close(); }
});

test('requests sync across both users and sessions, require acceptance, survive reload, and do not hide a DM', async ({ browser }) => {
  const target = seeded.find((user) => user.username === 'person105')!;
  const first = await openClient(browser, stack, 'alice');
  const second = await openClient(browser, stack, 'alice');
  const peer = await openClient(browser, stack, target.username);
  try {
    await search(first, target.username);
    await search(second, target.username);
    const firstRow = first.locator('.nav-person-row', { hasText: '@' + target.username });
    const secondRow = second.locator('.nav-person-row', { hasText: '@' + target.username });
    await firstRow.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
    await expect(secondRow.getByRole('button', { name: 'Отменить заявку', exact: true })).toBeEnabled();
    expect((await api('GET', '/contacts')).contact_ids).toEqual([]);
    await people(peer);
    const peerTabs = peer.locator('.people-tabs');
    await expect(peerTabs.getByRole('tab', { name: 'Заявки 1', exact: true })).toBeVisible();
    await peer.reload();
    await expect(peer.locator('.shell')).toBeVisible();
    await people(peer);
    await peerTabs.getByRole('tab', { name: 'Заявки 1', exact: true }).click();
    await expect(peer.locator('.request-item')).toHaveCount(1);
    await expect(peer.locator('.request-item')).toContainText('Входящая заявка');
    await peer.locator('.request-item').getByRole('button', { name: 'Принять', exact: true }).click();
    await expect(peer.locator('.request-item')).toHaveCount(0);
    await expect(secondRow.getByRole('button', { name: 'В контактах', exact: true })).toBeDisabled();
    expect((await api('GET', '/contacts')).contact_ids).toEqual([target.id]);
    await first.locator('.nav-search input').fill('');
    await first.locator('.people-tabs').getByRole('tab', { name: 'Контакты', exact: true }).click();
    await expect(first.locator('.nav-person')).toHaveCount(1);
    await first.locator('.nav-person').click();
    await first.locator('.composer textarea').fill('Диалог после подтверждения');
    await first.locator('.composer textarea').press('Enter');
    await expect(first.locator('.msg:not(.pending)')).toContainText('Диалог после подтверждения');
    await first.locator('.nav-person').click({ button: 'right' });
    await first.locator('.menu').getByRole('menuitem', { name: 'Профиль', exact: true }).click();
    await first.locator('.profile-card').getByRole('button', { name: 'Удалить из контактов', exact: true }).click();
    await first.keyboard.press('Escape');
    await expect(first.locator('.nav-person')).toHaveCount(0);
    await first.locator('.people-tabs').getByRole('tab', { name: 'Диалоги', exact: true }).click();
    await expect(first.locator('.nav-person')).toContainText(target.display_name);
    await first.locator('.nav-search input').fill(target.username);
    await expect(first.locator('.nav-person')).toContainText(target.display_name);
    await search(second, target.username);
    await secondRow.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
    await peerTabs.getByRole('tab', { name: 'Заявки 1', exact: true }).click();
    await peer.locator('.request-item').getByRole('button', { name: 'Отклонить', exact: true }).click();
    await expect(secondRow.getByRole('button', { name: 'Отправить заявку', exact: true })).toBeEnabled();
    await secondRow.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
    await expect(peer.locator('.request-item')).toHaveCount(1);
    await second.locator('.nav-search input').fill('');
    await second.locator('.people-tabs').getByRole('tab', { name: 'Заявки', exact: true }).click();
    await second.locator('.request-filters').getByRole('tab', { name: 'Исходящие', exact: true }).click();
    await expect(second.locator('.request-item')).toContainText('Заявка отправлена');
    await second.locator('.request-item').getByRole('button', { name: 'Отменить заявку', exact: true }).click();
    await expect(peer.locator('.request-item')).toHaveCount(0);
    await expect(second.locator('.request-item')).toHaveCount(0);
    await second.screenshot({ path: test.info().outputPath('outgoing-empty.png'), animations: 'disabled' });
  } finally { await Promise.all([first.context().close(), second.context().close(), peer.context().close()]); }
});

test('late directory responses cannot replace a newer search or leak an old account contact state', async ({ browser }) => {
  const oldContact = seeded.find((user) => user.username === 'person030')!;
  await api('PUT', `/contacts/${oldContact.id}`);
  const releases = new Map<string, () => void>();
  const held = new Set<string>();
  const page = await openClient(browser, stack, 'alice', 'password123', async (page) => {
    await page.route('**/users/directory?*', async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? '';
      if (!['person010', 'person030'].includes(q) || held.has(q)) return route.continue();
      held.add(q);
      const response = await route.fetch();
      await new Promise<void>((resolve) => releases.set(q, resolve));
      await route.fulfill({ response }).catch(() => {});
    });
  });
  try {
    await search(page, 'person010');
    await expect.poll(() => releases.has('person010')).toBe(true);
    await search(page, 'person020');
    await expect(page.locator('.nav-person')).toHaveCount(1);
    await expect(page.locator('.nav-person')).toContainText('@person020');
    releases.get('person010')!();
    await page.waitForTimeout(300);
    await expect(page.locator('.nav-person')).toContainText('@person020');
    await search(page, 'person030');
    await expect.poll(() => releases.has('person030')).toBe(true);
    await page.locator('.topbar-avatar').click();
    await page.locator('.self-menu').getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await page.locator('.modal.ask').getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await signIn(page, 'bob');
    await people(page);
    await expect(page.locator('.nav-person')).toHaveCount(0);
    releases.get('person030')!();
    await page.waitForTimeout(300);
    await expect(page.locator('.nav-person')).toHaveCount(0);
    await search(page, 'person030');
    const row = page.locator('.nav-person-row', { hasText: '@person030' });
    await expect(row.getByRole('button', { name: 'Отправить заявку', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Отменить заявку', exact: true })).toHaveCount(0);
  } finally { for (const release of releases.values()) release(); await page.context().close(); }
});


test('quick switcher Enter during debounce opens the new result and compact navigation keeps counts readable', async ({ browser }) => {
  const page = await openClient(browser, stack, 'alice');
  const target = seeded.find((user) => user.username === 'person020')!;
  try {
    await page.getByRole('button', { name: 'Найти или открыть', exact: true }).click();
    const input = page.locator('.switcher input');
    await input.fill('person010');
    await expect(page.locator('.switcher-item', { hasText: '@person010' })).toBeVisible();
    await input.fill(target.username);
    await input.press('Enter');
    await expect(page.locator('.switcher')).toHaveCount(0);
    await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', `Написать в «${target.display_name}»`);
    const peerToken = await loginToken(stack.api, 'bob');
    const response = await fetch(stack.api + '/api/v1/contacts/' + (await api('GET', '/me')).user.id, { method: 'PUT', headers: { Authorization: 'Bearer ' + peerToken } });
    expect(response.ok).toBe(true);
    const nav = await people(page);
    await expect(nav.locator('.request-count')).toHaveText('1');
    await nav.evaluate((element) => { element.style.width = '220px'; });
    await nav.locator('.people-tabs').getByRole('tab', { name: 'Заявки 1', exact: true }).click();
    await expect(nav.locator('.request-item')).toHaveCount(1);
    const layout = await nav.locator('.people-tabs button').evaluateAll((buttons) => buttons.map((button) => ({ width: button.clientWidth, content: button.scrollWidth })));
    expect(layout.every(({width,content}) => content <= width + 1)).toBe(true);
    const counter = nav.locator('.request-filters .request-count');
    const colors = await counter.evaluate((element) => { const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor }; });
    expect(colors.color).not.toBe(colors.background);
    await page.screenshot({ path: test.info().outputPath('requests-compact.png'), animations: 'disabled' });
    await nav.locator('.request-count').evaluateAll((badges) => badges.forEach((badge) => { badge.textContent = '1234'; }));
    for (const width of [220, 240, 260, 280, 300, 360]) {
      await nav.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      const sizes = await nav.locator('.people-tabs button').evaluateAll((buttons) => buttons.map((button) => ({ width: button.clientWidth, content: button.scrollWidth })));
      expect(sizes.every(({width,content}) => content <= width + 1), `sidebar width ${width}`).toBe(true);
      const filters = await nav.locator('.request-filters').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
      expect(filters.content).toBeLessThanOrEqual(filters.width + 1);
    }
  } finally { await page.context().close(); }
});


test('list refresh and later-page failures retry the failed operation; a late page cannot enter a new query', async ({ browser }) => {
  const bobToken = await loginToken(stack.api, 'bob');
  const bobID = (await api('GET', '/users/directory?q=bob')).users.find((user: {username: string}) => user.username === 'bob').id;
  const aliceID = (await api('GET', '/me')).user.id;
  const pending = await api('PUT', `/contacts/${bobID}`);
  const accept = await fetch(stack.api + `/api/v1/contacts/${aliceID}/accept`, { method: 'POST', headers: { Authorization: 'Bearer ' + bobToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: pending.relation.request_id }) });
  expect(accept.ok).toBe(true);
  const page = await openClient(browser, stack, 'alice', 'password123', async (page) => {
    await page.addInitScript(() => {
      const sockets: WebSocket[] = [];
      (window as any).peopleSockets = sockets;
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
      };
    });
  });
  let releaseMore: (() => void) | undefined;
  try {
    const nav = await people(page);
    await nav.locator('.people-tabs').getByRole('tab', { name: 'Контакты', exact: true }).click();
    await expect(nav.locator('.nav-person')).toHaveCount(1);
    let allowRefresh = false, refreshes = 0;
    await page.route('**/api/v1/contacts?*', async (route) => {
      refreshes++;
      if (allowRefresh) return route.continue();
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({error:{code:'temporary',message:'temporary'}}) });
    });
    await page.evaluate(() => (window as any).peopleSockets.forEach((socket: WebSocket) => socket.close()));
    await expect(nav.getByText('Не удалось загрузить участников', { exact: true })).toBeVisible();
    const beforeRetry = refreshes;
    allowRefresh = true;
    await nav.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect.poll(() => refreshes).toBeGreaterThan(beforeRetry);
    await expect(nav.getByText('Не удалось загрузить участников', { exact: true })).toHaveCount(0);
    await expect(nav.locator('.nav-person')).toHaveCount(1);
    let failedMore = false;
    await page.route('**/api/v1/users/directory?*', async (route) => {
      const url = new URL(route.request().url());
      const after = Number(url.searchParams.get('after'));
      if (url.searchParams.get('q') !== 'person' || !after) return route.continue();
      if (!failedMore) { failedMore = true; return route.fulfill({status:503,contentType:'application/json',body:'{}'}); }
      if (after >= 100) {
        const response = await route.fetch();
        await new Promise<void>((resolve) => { releaseMore = resolve; });
        return route.fulfill({response}).catch(() => {});
      }
      return route.continue();
    });
    await search(page, 'person');
    await expect(nav.locator('.nav-person-name').first()).toHaveText('Участник 001');
    const scroll = nav.locator('.people-scroll');
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(nav.getByText('Не удалось загрузить участников', { exact: true })).toBeVisible();
    await nav.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(nav.getByText('Не удалось загрузить участников', { exact: true })).toHaveCount(0);
    await expect(scroll.locator('.people-loading')).toHaveCount(0);
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => !!releaseMore).toBe(true);
    await search(page, '%_');
    await expect(nav.locator('.nav-person-name')).toHaveText('Символы 100%_literal');
    releaseMore!();
    await page.waitForTimeout(100);
    await expect(nav.locator('.nav-person')).toHaveCount(1);
    await expect(nav.locator('.nav-person-name')).toHaveText('Символы 100%_literal');
  } finally { releaseMore?.(); await page.context().close(); }
});


test('removing a contact from a filtered deep page preserves the remaining list and scroll position', async ({ browser }) => {
  const aliceID = (await api('GET', '/me')).user.id;
  const peerIDs = seeded.slice(0, 110).map((user) => user.id);
  const python = path.join(root, 'server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  execFileSync(python, ['-c', `
import asyncio,json,sys
from pathlib import Path
from tolktak import db
from tolktak.store import users
async def main():
    directory=Path(sys.argv[1]).resolve()
    assert directory.name.startswith('tolktak-e2e-') and (directory/'tolktak.db').is_file()
    await db.init('',directory)
    for peer in json.loads(sys.argv[3]):
        states,_=await users.change_contact(int(sys.argv[2]),peer,'send')
        await users.change_contact(peer,int(sys.argv[2]),'accept',states[int(sys.argv[2])]['relation']['request_id'])
    await db.close()
asyncio.run(main())
`, stack.dataDir, String(aliceID), JSON.stringify(peerIDs)], {cwd:path.join(root,'server')});
  const page = await openClient(browser, stack, 'alice', 'password123', async (page) => {
    await page.route('**/renderer.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + '\nwindow.peopleCacheAudit = users;' });
    });
  });
  try {
    const nav = await people(page);
    await nav.locator('.people-tabs').getByRole('tab', {name:'Контакты',exact:true}).click();
    await nav.locator('.nav-search input').fill('person');
    await expect(nav.locator('.nav-person-name').first()).toHaveText('Участник 001');
    const rows = nav.locator('.people-virtual-row > [data-user-id]');
    const beforeEviction = await rows.evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.userId)));
    const evicted = beforeEviction[5];
    let releaseProfile: (() => void) | undefined;
    let holdProfile = true;
    await page.route('**/api/v1/users/profiles', async (route) => {
      if (!holdProfile || !route.request().postDataJSON().ids.includes(evicted)) return route.continue();
      const response = await route.fetch();
      await new Promise<void>((resolve) => { releaseProfile = resolve; });
      return route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate((id) => {
      const profiles = (window as any).peopleCacheAudit;
      const next = new Map(profiles.value);
      next.delete(id);
      profiles.value = next;
    }, evicted);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await rows.evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.userId)))).toEqual(beforeEviction);
    holdProfile = false;
    releaseProfile?.();
    const scroll = nav.locator('.people-scroll');
    for (let part=0;part<2;part++) {
      await scroll.evaluate((element)=>{element.scrollTop=element.scrollHeight});
      await expect(scroll.locator('.people-loading')).toHaveCount(0);
      await page.waitForTimeout(100);
    }
    await scroll.evaluate((element)=>{element.scrollTop=element.scrollHeight});
    const row=nav.locator('.nav-person', {hasText:'Участник 110'});
    await expect(row).toBeVisible();
    const before=await scroll.evaluate((element)=>element.scrollTop);
    await row.click({button:'right'});
    await page.locator('.menu').getByRole('menuitem',{name:'Профиль',exact:true}).click();
    await page.locator('.profile-card').getByRole('button',{name:'Удалить из контактов',exact:true}).click();
    await page.keyboard.press('Escape');
    await expect(nav.locator('.nav-person',{hasText:'Участник 109'})).toBeVisible();
    expect(Math.abs(await scroll.evaluate((element)=>element.scrollTop)-before)).toBeLessThan(90);
    await expect(scroll.locator('.people-loading')).toHaveCount(0);
    expect(Math.abs(await scroll.evaluate((element)=>element.scrollTop)-before)).toBeLessThan(90);
  } finally {await page.context().close();}
});
