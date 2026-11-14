import { chromium, firefox, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPEN_WEB_TEST_URL;
if (!base) throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; browser tests can modify its database');

const viewports = [
  { name: 'desktop', width: 1365, height: 900, touch: false },
  { name: 'large desktop', width: 1920, height: 1080, touch: false },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'narrow mobile', width: 320, height: 640, touch: true },
  { name: 'mobile landscape', width: 844, height: 390, touch: true },
];

const browserName = process.env.OPEN_WEB_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw Error(`Unsupported browser: ${browserName}`);
const executablePath = process.env.BROWSER_PATH ?? (browserName === 'chromium' ? process.env.CHROMIUM_PATH : undefined);
const browser = await browserType.launch({ executablePath });
const screenshotDir = process.env.MENU_SCREENSHOT_DIR;
async function screenshot(page, name) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, name) });
}
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(`${base}/wall`);
    await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
    const menu = page.locator('.global-menu[data-top-disclosure]');
    const trigger = menu.locator('summary');
    const panel = page.locator('#global-menu-panel');
    const canvas = page.locator('#wall');
    let placements = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/wall/pixel')) placements++;
    });

    async function assertMenuVisible(expectedPath) {
      const result = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const triggerRect = element.querySelector('summary').getBoundingClientRect();
        const style = getComputedStyle(element);
        const hit = document.elementFromPoint(triggerRect.x + triggerRect.width / 2, triggerRect.y + triggerRect.height / 2);
        return {
          position: style.position,
          zIndex: Number(style.zIndex),
          rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
          trigger: { x: triggerRect.x, y: triggerRect.y, width: triggerRect.width, height: triggerRect.height },
          viewport: { width: innerWidth, height: innerHeight },
          top: style.top,
          left: style.left,
          isTopHit: hit?.closest('.global-menu') === element,
        };
      });
      assert.equal(result.position, 'fixed', `${viewport.name}: menu must be fixed on ${expectedPath}`);
      assert.ok(result.zIndex >= 10, `${viewport.name}: menu must stack above page content`);
      assert.ok(result.rect.x >= 0 && result.rect.y >= 0, `${viewport.name}: menu starts inside the viewport`);
      assert.ok(result.rect.right <= result.viewport.width && result.rect.bottom <= result.viewport.height, `${viewport.name}: menu fits in the viewport`);
      assert.ok(result.trigger.width >= 30 && result.trigger.height >= 30, `${viewport.name}: trigger has a usable hit target`);
      assert.ok(result.isTopHit, `${viewport.name}: menu trigger is not covered by page content`);
      assert.match(result.top, /^\d+(?:\.\d+)?px$/);
      assert.match(result.left, /^\d+(?:\.\d+)?px$/);

      const links = await panel.locator('nav a').evaluateAll(elements => elements.map(element => ({
        text: element.textContent?.trim(),
        href: element.getAttribute('href'),
        current: element.getAttribute('aria-current'),
      })));
      assert.equal(links.length, 2, 'the menu lists both active spaces');
      const currentName = expectedPath === '/wall' ? 'The Wall' : 'Global Chat';
      const otherName = expectedPath === '/wall' ? 'Global Chat' : 'The Wall';
      assert.deepEqual(links.find(link => link.text === currentName), {
        text: currentName,
        href: expectedPath,
        current: 'page',
      });
      assert.deepEqual(links.find(link => link.text === otherName), {
        text: otherName,
        href: expectedPath === '/wall' ? '/chat' : '/wall',
        current: null,
      });
    }

    await assertMenuVisible('/wall');
    assert.equal(await menu.evaluate(element => element.open), false);
    if (viewport.touch) await trigger.tap();
    else await trigger.click();
    assert.equal(await menu.evaluate(element => element.open), true);
    assert.equal(await panel.isVisible(), true);
    if (viewport.name === 'desktop' || viewport.name === 'narrow mobile') await screenshot(page, `wall-open-${viewport.width}.png`);

    if (viewport.touch) await canvas.tap({ position: { x: viewport.width / 2, y: viewport.height / 2 } });
    else await page.mouse.click(viewport.width / 2, viewport.height / 2);
    assert.equal(await menu.evaluate(element => element.open), false);
    assert.equal(placements, 0, 'dismissing the menu on the canvas does not place a pixel');
    const placement = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/wall/pixel'));
    if (viewport.touch) await canvas.tap({ position: { x: viewport.width / 2, y: viewport.height / 2 } });
    else await page.mouse.click(viewport.width / 2, viewport.height / 2);
    assert.equal((await placement).status(), 200, 'canvas remains interactive after the menu closes');
    assert.equal(placements, 1);
    if (viewport.touch) await trigger.tap();
    else await trigger.click();
    assert.equal(await menu.evaluate(element => element.open), true);

    await panel.getByRole('link', { name: 'Global Chat' }).click();
    await page.waitForURL(url => new URL(url).pathname.replace(/\/$/, '') === '/chat');
    assert.equal(await menu.evaluate(element => element.open), false);
    await assertMenuVisible('/chat');

    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await menu.evaluate(element => element.open), true);
    if (viewport.name === 'desktop' || viewport.name === 'narrow mobile') await screenshot(page, `chat-open-${viewport.width}.png`);
    await page.keyboard.press('Tab');
    assert.equal(await panel.getByRole('link').first().evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Escape');
    assert.equal(await menu.evaluate(element => element.open), false);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);

    if (viewport.touch) await trigger.tap();
    else await trigger.click();
    assert.equal(await menu.evaluate(element => element.open), true);
    await panel.getByRole('link', { name: 'The Wall' }).click();
    await page.waitForURL(url => new URL(url).pathname.replace(/\/$/, '') === '/wall');
    assert.equal(await menu.evaluate(element => element.open), false);
    await assertMenuVisible('/wall');
    assert.deepEqual(errors, [], `${viewport.name}: no uncaught browser errors`);
    console.log(`PASS global menu ${viewport.name} (${viewport.width}x${viewport.height})`);
    await context.close();
  }
} finally {
  await browser.close();
}
