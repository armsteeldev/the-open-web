import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';

const base = process.env.OPEN_WEB_TEST_URL;
if (!base) throw Error('Set OPEN_WEB_TEST_URL to an isolated built site');

const engines = [
  { name: 'Chromium', browserType: chromium, executablePath: process.env.CHROMIUM_PATH },
  { name: 'Firefox', browserType: firefox },
  { name: 'WebKit', browserType: webkit },
];
const routes = ['/wall', '/chat', '/bottle', '/guestbook', '/story', '/questions', '/choice', '/draw', '/garden', '/map'];
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

for (const engine of engines) {
  const executablePath = engine.executablePath ?? engine.browserType.executablePath();
  if (!existsSync(executablePath)) {
    console.log(`${engine.name}: SKIP (browser executable is not installed)`);
    continue;
  }

  const browser = await engine.browserType.launch({
    headless: true,
    ...(engine.executablePath ? { executablePath: engine.executablePath } : {}),
  });
  const errors = [];
  let checkedPages = 0;

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      page.setDefaultTimeout(6_000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && !message.text().includes('WebSocket')) errors.push(message.text());
      });
      page.on('request', request => {
        if (new URL(request.url()).origin !== new URL(base).origin) errors.push(`external request: ${request.url()}`);
      });

      for (const route of routes) {
        const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        assert.equal(response?.status(), 200, `${engine.name} ${route}`);
        if (route === '/wall') await page.locator('#wall').waitFor({ state: 'visible' });
        else await page.locator('h1').first().waitFor({ state: 'visible' });
        if (route === '/map') await page.locator('#country-shapes path').first().waitFor({ state: 'visible' });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${engine.name} ${viewport.width}px layout overflowed at ${route}`,
        );
        await page.getByLabel('Spaces', { exact: true }).first().click();
        assert.equal(await page.locator('.global-menu nav a').count(), 10, `${engine.name} menu at ${route}`);
        checkedPages++;
      }
      await context.close();
    }

    assert.deepEqual(errors, [], `${engine.name} browser errors`);
    console.log(`${engine.name}: PASS ${checkedPages} route/viewport checks; navigation opens with ten spaces`);
  } finally {
    await browser.close();
  }
}
