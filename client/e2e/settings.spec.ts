import { expect, test } from '@playwright/test';
import { groupIn, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  const alice = await register(stack.api, 'alice');
  const bob = await register(stack.api, 'bob');
  const token = await loginToken(stack.api, 'alice');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const response = await fetch(stack.api + '/api/v1/groups', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Настройки', members: [bob.user.id], channel_name: 'общий', room_name: 'Общая' }),
  });
  expect(response.ok).toBeTruthy();
  const { group } = await response.json();
  const channel = await fetch(`${stack.api}/api/v1/groups/${group.id}/channels`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'второй' }),
  });
  expect(channel.ok).toBeTruthy();
  expect(alice.user.id).not.toBe(bob.user.id);
});
test.afterAll(async () => stack?.stop());

test('settings block desk resizing and shortcuts, retain focus and survive a nested dialog', async ({ browser }) => {
  const page = await openClient(browser, stack, 'alice');
  try {
    await groupIn(page, 'Настройки').click();
    await page.locator('.nav-row', { hasText: 'второй' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Открыть рядом', exact: true }).click();
    const panels = page.locator('.workspace .dv-groupview');
    await expect(panels).toHaveCount(2);
    const bounds = () => panels.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round);
    }));
    const sash = (await page.locator('.workspace .dv-sash.dv-enabled').first().boundingBox())!;
    const x = sash.x + sash.width / 2;
    const y = sash.y + sash.height / 2;
    const before = await bounds();
    await page.locator('.topbar-avatar').click();
    await page.locator('.self-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
    const modal = page.locator('.settings-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('.settings-nav').getByRole('button', { name: 'Сервер', exact: true })).toBeVisible();
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.modal-backdrop'), { x, y })).toBe(true);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (sash.width < sash.height ? 50 : 0), y + (sash.width >= sash.height ? 50 : 0), { steps: 6 });
    await page.mouse.up();
    expect(await bounds()).toEqual(before);
    const about = modal.getByRole('textbox', { name: 'О себе', exact: true });
    const area = (await about.boundingBox())!;
    await page.mouse.move(area.x + area.width - 2, area.y + area.height - 2);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width - 2, Math.min(780, area.y + area.height + 160), { steps: 6 });
    await page.mouse.up();
    expect((await about.boundingBox())!.height).toBeCloseTo(area.height, 0);
    await about.focus();
    await page.keyboard.press('F6');
    expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.switcher')).toHaveCount(0);
    const logout = modal.getByRole('button', { name: 'Выйти из аккаунта', exact: true });
    await logout.focus();
    await page.keyboard.press('Tab');
    await expect(modal.locator('header').getByRole('button', { name: 'Закрыть', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(logout).toBeFocused();
    await page.locator('.settings-nav').getByRole('button', { name: 'Интерфейс', exact: true }).click();
    await expect(modal.getByRole('heading', { name: 'Окна', exact: true })).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Оформление', exact: true })).toHaveCount(1);
    const actions = page.locator('.settings-actions button');
    const first = (await actions.nth(0).boundingBox())!;
    const second = (await actions.nth(1).boundingBox())!;
    expect(second.y >= first.y + first.height + 10 || second.x >= first.x + first.width + 10).toBe(true);
    await page.screenshot({ path: test.info().outputPath('interface.png') });
    await modal.getByRole('button', { name: 'Сбросить расположение окон', exact: true }).click();
    await expect(page.locator('.modal.ask')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal.ask')).toHaveCount(0);
    await expect(page.locator('.shell')).toHaveJSProperty('inert', true);
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.shell')).toHaveJSProperty('inert', false);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (sash.width < sash.height ? 50 : 0), y + (sash.width >= sash.height ? 50 : 0), { steps: 6 });
    await page.mouse.up();
    await expect.poll(bounds).not.toEqual(before);
  } finally {
    await page.context().close();
  }
});

test('window tips can be disabled, survive a reload and be enabled again', async ({ browser }) => {
  const page = await openClient(browser, stack, 'alice');
  try {
    const settings = async () => {
      await page.locator('.topbar-avatar').click();
      await page.locator('.self-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
      await page.locator('.settings-nav').getByRole('button', { name: 'Интерфейс', exact: true }).click();
    };
    const openBeside = async () => {
      await page.locator('.nav-row', { hasText: 'второй' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Открыть рядом', exact: true }).click();
    };
    const tips = page.getByRole('checkbox', { name: /^Показывать подсказки/ });
    await settings();
    await expect(tips).toBeChecked();
    await tips.uncheck();
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await settings();
    await expect(tips).not.toBeChecked();
    await page.keyboard.press('Escape');
    await groupIn(page, 'Настройки').click();
    await page.setViewportSize({ width: 760, height: 800 });
    await openBeside();
    const panels = page.locator('.workspace .dv-groupview');
    await expect(panels).toHaveCount(1);
    await expect(page.locator('.workspace .dv-tab')).toHaveCount(2);
    await expect(page.locator('.toast', { hasText: 'Окно перемещено во вкладки' })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panels).toHaveCount(2);
    await panels.filter({ hasNot: page.locator('.win-main') }).getByRole('button', { name: 'Меню окна', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Закрыть окно', exact: true }).click();
    await settings();
    await tips.check();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 760, height: 800 });
    await openBeside();
    await expect(panels).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'Окно перемещено во вкладки' })).toBeVisible();
  } finally {
    await page.context().close();
  }
});

for (const copy of [
  { locale: 'ru', settings: 'Настройки', streams: 'Трансляции', server: 'Сервер', duck: 'Приглушать трансляцию при разговоре', volume: 'Громкость трансляций' },
  { locale: 'en', settings: 'Settings', streams: 'Streams', server: 'Server', duck: 'Lower stream volume while people talk', volume: 'Stream volume' },
]) {
  test(`stream sliders keep their geometry and regular users have no server tab (${copy.locale})`, async ({ browser }) => {
    const page = await openClient(browser, stack, 'bob');
    try {
      if (copy.locale === 'en') {
        await page.evaluate(() => localStorage.setItem('tolktak.locale', 'en'));
        await page.reload();
        await expect(page.locator('.shell')).toBeVisible();
      }
      let adminRequests = 0;
      page.on('request', (r) => { if (r.url().includes('/admin/update')) adminRequests++; });
      await page.locator('.topbar-avatar').click();
      await page.locator('.self-menu').getByRole('button', { name: copy.settings, exact: true }).click();
      const modal = page.locator('.settings-modal');
      await expect(page.locator('.settings-nav').getByRole('button', { name: copy.server, exact: true })).toHaveCount(0);
      await page.locator('.settings-nav').getByRole('button', { name: copy.streams, exact: true }).click();
      await modal.locator('.settings-body').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
      await modal.getByRole('checkbox', { name: copy.duck, exact: true }).check();
      await expect(modal.locator('.slider')).toHaveCount(2);
      const geometry = () => modal.locator('.slider').evaluateAll((els) => els.map((el) => {
        const label = el.querySelector('.slider-label')!.getBoundingClientRect();
        const range = el.querySelector('input')!.getBoundingClientRect();
        const value = el.querySelector('.slider-val')!.getBoundingClientRect();
        return { x: range.x, width: range.width, y: range.y, labelBottom: label.bottom, valueWidth: value.width };
      }));
      const volume = modal.getByRole('slider', { name: copy.volume, exact: true });
      await volume.focus();
      await page.keyboard.press('Home');
      await expect(modal.locator('.slider-val').first()).toHaveText('0%');
      const before = await geometry();
      await page.keyboard.press('End');
      await expect(modal.locator('.slider-val').first()).toHaveText('200%');
      const after = await geometry();
      expect(after).toEqual(before);
      expect(after[0].x).toBeCloseTo(after[1].x, 0);
      expect(after[0].width).toBeCloseTo(after[1].width, 0);
      expect(after.every((r) => r.y >= r.labelBottom)).toBe(true);
      expect(adminRequests).toBe(0);
      await page.screenshot({ path: test.info().outputPath(`streams-${copy.locale}.png`) });
    } finally {
      await page.context().close();
    }
  });
}
