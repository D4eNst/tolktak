import { expect, test } from '@playwright/test';
import { groupIn, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
let token: string;

test.beforeAll(async () => {
  stack = await startStack();
  await register(stack.api, 'alice');
  token = await loginToken(stack.api, 'alice');
});
test.afterAll(async () => stack?.stop());

for (const copy of [
  { locale: 'ru', hide: 'Свернуть боковую панель', show: 'Развернуть боковую панель', query: 'панель', menu: 'Меню группы', micOff: 'Выключить микрофон', micOn: 'Включить микрофон', camOn: 'Включить камеру', camOff: 'Выключить камеру', preview: 'Предпросмотр камеры', share: 'Показать экран', source: 'Изменить источник трансляции', stats: 'Статистика трансляции', leave: 'Выйти из звонка' },
  { locale: 'en', hide: 'Collapse sidebar', show: 'Expand sidebar', query: 'sidebar', menu: 'Group menu', micOff: 'Mute microphone', micOn: 'Unmute microphone', camOn: 'Turn camera on', camOff: 'Turn camera off', preview: 'Camera preview', share: 'Share screen', source: 'Change stream source', stats: 'Stream statistics', leave: 'Leave call' },
]) {
  test(`action labels follow sidebar, microphone, camera and stream state (${copy.locale})`, async ({ browser }) => {
    const name = 'Labels-' + copy.locale;
    const response = await fetch(stack.api + '/api/v1/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ name, members: [], room_name: 'Общая' }),
    });
    expect(response.ok).toBeTruthy();
    const page = await openClient(browser, stack, 'alice');
    try {
      if (copy.locale === 'en') {
        await page.evaluate(() => localStorage.setItem('tolktak.locale', 'en'));
        await page.reload();
        await expect(page.locator('.shell')).toBeVisible();
      }
      await page.locator('.topbar-search').click();
      await page.locator('.switcher input').fill(copy.query);
      await page.locator('.switcher').getByRole('button', { name: new RegExp('^' + copy.hide) }).click();
      await expect(page.locator('.nav-rail').getByRole('button', { name: copy.show, exact: true })).toBeVisible();
      await page.locator('.topbar-search').click();
      await page.locator('.switcher input').fill(copy.query);
      await page.locator('.switcher').getByRole('button', { name: new RegExp('^' + copy.show) }).click();
      await groupIn(page, name).click();
      await expect(page.locator('.nav-page-head').getByRole('button', { name: copy.menu, exact: true })).toBeVisible();
      await page.locator('.nav-row', { hasText: 'Общая' }).click();
      await expect(page.locator('.capsule .dot.ok')).toBeVisible();
      const controls = page.locator('.call-controls');
      await controls.getByRole('button', { name: copy.micOff, exact: true }).click();
      await expect(controls.getByRole('button', { name: copy.micOn, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await controls.getByRole('button', { name: copy.micOn, exact: true }).click();
      await controls.getByRole('button', { name: copy.camOn, exact: true }).click();
      await expect(page.locator('.modal h2')).toHaveText(copy.preview);
      await page.locator('.modal button.primary').click();
      await controls.getByRole('button', { name: copy.camOff, exact: true }).click();
      await expect(controls.getByRole('button', { name: copy.camOn, exact: true })).toBeVisible();
      await controls.getByRole('button', { name: copy.share, exact: true }).click();
      await page.locator('.share-options input[type=checkbox]').first().uncheck();
      await page.locator('.modal button.primary').click();
      await expect(controls.getByRole('button', { name: copy.source, exact: true })).toBeVisible();
      await expect(page.locator('.theater').getByRole('button', { name: copy.stats, exact: true })).toBeVisible();
      await controls.getByRole('button', { name: copy.leave, exact: true }).click();
      await expect(page.locator('.call-controls')).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
}
