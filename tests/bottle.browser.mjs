import { chromium, firefox, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPEN_WEB_TEST_URL;
if (!base) throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; Bottle browser checks can modify its database');
const browserName = process.env.OPEN_WEB_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw Error(`Unsupported browser: ${browserName}`);
const executablePath = process.env.BROWSER_PATH ?? (browserName === 'chromium' ? process.env.CHROMIUM_PATH : undefined);
const screenshotDir = process.env.BOTTLE_SCREENSHOT_DIR;
const browser = await browserType.launch({ executablePath });
const mobileContextOptions = viewport => ({ viewport, ...(browserName === 'firefox' ? {} : { isMobile: true, hasTouch: true }) });

async function screenshot(page, name) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
}

try {
  const mobileEmptyContext = await browser.newContext(mobileContextOptions({ width: 390, height: 844 }));
  const mobileEmpty = await mobileEmptyContext.newPage();
  await mobileEmpty.goto(`${base}/bottle`);
  await mobileEmpty.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await screenshot(mobileEmpty, 'bottle-mobile-empty.png');
  await mobileEmpty.getByRole('button', { name: 'Find a bottle' }).click();
  await mobileEmpty.getByText('No bottles yet. Leave the first one.', { exact: true }).waitFor();
  await screenshot(mobileEmpty, 'bottle-mobile-empty-pool.png');

  const desktopContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const desktop = await desktopContext.newPage();
  const errors = [];
  const recordConsoleError = message => { if (message.type() === 'error') errors.push(message.text()); };
  desktop.on('pageerror', error => errors.push(error.message));
  desktop.on('console', recordConsoleError);
  await desktop.goto(`${base}/bottle`);
  await desktop.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await desktop.getByRole('heading', { name: 'Message in a Bottle' }).waitFor();
  assert.equal(await desktop.locator('#release-feedback').textContent(), '');
  await screenshot(desktop, 'bottle-desktop-empty.png');
  assert.ok(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await desktop.locator('#find-bottle').click();
  await desktop.getByText('No bottles yet. Leave the first one.', { exact: true }).waitFor();
  assert.equal(await desktop.locator('#current-bottle').isVisible(), false);
  await screenshot(desktop, 'bottle-desktop-empty-pool.png');
  await desktop.getByLabel('Leave one').fill('A short note to someone finding this place.');
  await desktop.getByPlaceholder('Sign it (optional)').fill('from here');
  await screenshot(desktop, 'bottle-desktop-writing.png');
  await desktop.getByLabel('Leave one').fill('');
  await desktop.getByPlaceholder('Sign it (optional)').fill('');
  await desktop.getByRole('button', { name: 'Release bottle' }).click();
  await desktop.getByText('Write a message before releasing it.', { exact: true }).waitFor();

  const literal = '<img src=x onerror="window.bottleInjected=true"> & a note\nsecond line 👩‍💻 café';
  const firstSend = desktop.waitForResponse(response => response.url().endsWith('/api/bottle/messages') && response.request().method() === 'POST');
  await desktop.getByLabel('Leave one').click();
  await desktop.getByLabel('Leave one').fill(literal);
  await desktop.getByPlaceholder('Sign it (optional)').fill('<b>from the shore</b>');
  await desktop.getByRole('button', { name: 'Release bottle' }).focus();
  await desktop.keyboard.press('Enter');
  const firstResponse = await firstSend;
  assert.equal(firstResponse.status(), 200);
  const firstCreated = (await firstResponse.json()).bottle;
  await desktop.getByText(/Bottle released\. You can leave another bottle in \d+ seconds?\./).waitFor();
  await screenshot(desktop, 'bottle-desktop-cooldown.png');
  assert.equal(await desktop.getByLabel('Leave one').inputValue(), '');
  assert.equal(await desktop.getByPlaceholder('Sign it (optional)').inputValue(), '');

  assert.deepEqual(await desktop.evaluate(() => JSON.parse(localStorage.getItem('the-open-web.bottle.recent'))), [firstCreated.id]);
  await desktop.reload();
  await desktop.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  assert.deepEqual(await desktop.evaluate(() => JSON.parse(localStorage.getItem('the-open-web.bottle.recent'))), [firstCreated.id]);

  const sameVisitor = await desktopContext.newPage();
  const sameVisitorErrors = [];
  sameVisitor.on('pageerror', error => sameVisitorErrors.push(error.message));
  await sameVisitor.goto(`${base}/bottle`);
  await sameVisitor.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await sameVisitor.getByLabel('Leave one').fill('A second bottle waits a little.');
  const cooldownResponse = sameVisitor.waitForResponse(response => response.url().endsWith('/api/bottle/messages') && response.request().method() === 'POST');
  await sameVisitor.getByRole('button', { name: 'Release bottle' }).click();
  assert.equal((await cooldownResponse).status(), 429);
  await sameVisitor.getByText(/Wait \d+ seconds? before leaving another bottle\. Your draft stays here\./).waitFor();
  assert.equal(await sameVisitor.getByLabel('Leave one').inputValue(), 'A second bottle waits a little.');
  assert.equal(await sameVisitor.locator('#release-bottle').isDisabled(), true);
  await sameVisitor.setViewportSize({ width: 390, height: 844 });
  await screenshot(sameVisitor, 'bottle-mobile-cooldown.png');

  const freshWriterContext = await browser.newContext(mobileContextOptions({ width: 390, height: 844 }));
  const freshWriter = await freshWriterContext.newPage();
  await freshWriter.goto(`${base}/bottle`);
  await freshWriter.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await freshWriter.getByLabel('Leave one').fill('A second bottle waits a little.');
  await freshWriter.getByPlaceholder('Sign it (optional)').fill('from elsewhere');
  await screenshot(freshWriter, 'bottle-mobile-writing.png');
  const secondSend = freshWriter.waitForResponse(response => response.url().endsWith('/api/bottle/messages') && response.request().method() === 'POST');
  await freshWriter.getByRole('button', { name: 'Release bottle' }).click();
  const secondResponse = await secondSend;
  assert.equal(secondResponse.status(), 200);
  const secondCreated = (await secondResponse.json()).bottle;
  assert.deepEqual(await freshWriter.evaluate(() => JSON.parse(localStorage.getItem('the-open-web.bottle.recent'))), [secondCreated.id]);
  const firstFoundResponse = freshWriter.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await freshWriter.getByRole('button', { name: 'Find a bottle' }).click();
  assert.equal((await firstFoundResponse).status(), 200);
  await freshWriter.getByText(literal, { exact: true }).waitFor();
  assert.equal(await freshWriter.locator('#bottle-signature').textContent(), '<b>from the shore</b>');
  assert.equal(await freshWriter.locator('#bottle-message img, #bottle-message script').count(), 0);
  assert.equal(await freshWriter.evaluate(() => window.bottleInjected === true), false);
  const time = await freshWriter.locator('#bottle-time').evaluate(element => ({ text: element.textContent, datetime: element.getAttribute('datetime') }));
  assert.ok(time.datetime && Number.isFinite(Date.parse(time.datetime)));
  assert.equal(time.text, await freshWriter.evaluate(value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)), Date.parse(time.datetime)));
  await freshWriter.locator('#current-bottle').waitFor({ state: 'visible' });

  const mobileReaderContext = await browser.newContext(mobileContextOptions({ width: 390, height: 844 }));
  const mobileReader = await mobileReaderContext.newPage();
  await mobileReader.addInitScript(id => localStorage.setItem('the-open-web.bottle.recent', JSON.stringify([id])), firstCreated.id);
  await mobileReader.goto(`${base}/bottle`);
  await mobileReader.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  const mobileFoundResponse = mobileReader.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await mobileReader.getByRole('button', { name: 'Find a bottle' }).click();
  assert.equal((await mobileFoundResponse).status(), 200);
  await mobileReader.getByText('A second bottle waits a little.', { exact: true }).waitFor();
  await screenshot(mobileReader, 'bottle-mobile-found.png');

  const another = desktop.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await desktop.getByRole('button', { name: 'Find a bottle' }).click();
  const anotherResponse = await another;
  assert.equal(anotherResponse.status(), 200);
  const secondFound = (await anotherResponse.json()).bottle;
  await desktop.getByText('A second bottle waits a little.', { exact: true }).waitFor();
  assert.notEqual(secondCreated.id, firstCreated.id);
  assert.equal(secondFound.id, secondCreated.id);
  await screenshot(desktop, 'bottle-desktop-found.png');

  const exhausted = desktop.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await desktop.getByRole('button', { name: 'Find another' }).click();
  assert.equal((await exhausted).status(), 200);
  await desktop.getByText('You’ve found every bottle for now.', { exact: true }).waitFor();
  assert.equal(await desktop.getByRole('button', { name: 'Find again' }).textContent(), 'Find again');
  assert.equal(await desktop.locator('#current-bottle').isVisible(), false);
  await screenshot(desktop, 'bottle-desktop-exhausted.png');
  const restartDrift = desktop.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await desktop.getByRole('button', { name: 'Find again' }).click();
  assert.equal((await restartDrift).status(), 200);
  await desktop.locator('#current-bottle').waitFor({ state: 'visible' });
  assert.equal(await desktop.getByRole('button', { name: 'Find another' }).textContent(), 'Find another');

  const longMessage = [
    'At the end of the pier, the gulls have learned to wait for the bakery van. This morning one of them landed beside me and watched the harbor wake up.',
    'A small boat crossed the pale water, the first café opened its door, and someone waved from a window across the quay. I had nowhere urgent to be.',
    'I stayed until the sun reached the rooftops. If you are reading this on a hurried day, I hope you find one quiet minute of your own.',
  ].join('\n\n');
  const longWriterContext = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const longWriter = await longWriterContext.newPage();
  await longWriter.goto(`${base}/bottle`);
  await longWriter.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await longWriter.getByLabel('Leave one').fill(longMessage);
  const longSend = longWriter.waitForResponse(response => response.url().endsWith('/api/bottle/messages') && response.request().method() === 'POST');
  await longWriter.getByRole('button', { name: 'Release bottle' }).click();
  const longResponse = await longSend;
  assert.equal(longResponse.status(), 200);
  const longCreated = (await longResponse.json()).bottle;
  const longReaderContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const longReader = await longReaderContext.newPage();
  await longReader.addInitScript(ids => localStorage.setItem('the-open-web.bottle.recent', JSON.stringify(ids)), [firstCreated.id, secondCreated.id]);
  await longReader.goto(`${base}/bottle`);
  await longReader.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  const longFind = longReader.waitForResponse(response => response.url().includes('/api/bottle/random'));
  await longReader.getByRole('button', { name: 'Find a bottle' }).click();
  const longFoundResponse = await longFind;
  assert.equal(longFoundResponse.status(), 200);
  await longReader.getByText(longMessage, { exact: true }).waitFor();
  assert.equal((await longFoundResponse.json()).bottle?.id, longCreated.id);
  await screenshot(longReader, 'bottle-desktop-long.png');
  await longReader.setViewportSize({ width: 390, height: 844 });
  const longMobileLayout = await longReader.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    release: document.querySelector('#release-bottle').getBoundingClientRect().toJSON(),
  }));
  assert.ok(longMobileLayout.width <= longMobileLayout.viewport, 'long mobile reading has no horizontal overflow');
  assert.ok(longMobileLayout.release.x >= 0 && longMobileLayout.release.right <= longMobileLayout.viewport, 'release action fits below long mobile reading');
  await screenshot(longReader, 'bottle-mobile-long.png');

  desktop.off('console', recordConsoleError);
  await desktop.route('**/api/bottle/random**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' }));
  await desktop.locator('#find-bottle').click();
  await desktop.getByText('The water is hard to reach right now. Try again in a moment.', { exact: true }).waitFor();
  await desktop.unrouteAll({ behavior: 'wait' });
  desktop.on('console', recordConsoleError);

  const failureContext = await browser.newContext(mobileContextOptions({ width: 320, height: 640 }));
  const failurePage = await failureContext.newPage();
  await failurePage.goto(`${base}/bottle`);
  await failurePage.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await failurePage.route('**/api/bottle/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"writes disabled"}' }));
  const draft = 'This draft stays when the release service is unavailable.';
  await failurePage.getByLabel('Leave one').fill(draft);
  await failurePage.getByRole('button', { name: 'Release bottle' }).click();
  await failurePage.getByText('Releasing is temporarily paused. Your draft is still here.', { exact: true }).waitFor();
  assert.equal(await failurePage.getByLabel('Leave one').inputValue(), draft);
  assert.ok(await failurePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 768, height: 1024 },
    { width: 320, height: 640 },
    { width: 844, height: 390 },
  ]) {
    await desktop.setViewportSize(viewport);
    const measurements = await desktop.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      action: document.querySelector('#release-bottle').getBoundingClientRect().toJSON(),
      reading: document.querySelector('#current-bottle').getBoundingClientRect().toJSON(),
    }));
    assert.ok(measurements.width <= measurements.viewport, `${viewport.width}x${viewport.height}: no horizontal overflow`);
    assert.ok(measurements.action.x >= 0 && measurements.action.right <= viewport.width, `${viewport.width}x${viewport.height}: release button fits`);
  }

  await screenshot(failurePage, 'bottle-mobile-draft-error.png');
  await freshWriter.waitForFunction(() => document.querySelector('#release-feedback')?.textContent === '', null, { timeout: 25_000 });
  assert.equal(await freshWriter.locator('#release-bottle').isDisabled(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(sameVisitorErrors, []);
  console.log('PASS Bottle empty state, plain-text reading, local time, random non-repeat discovery, anonymous release, cooldown, draft recovery, and desktop/mobile layouts');
  await failureContext.close();
  await longReaderContext.close();
  await longWriterContext.close();
  await freshWriterContext.close();
  await mobileReaderContext.close();
  await desktopContext.close();
  await mobileEmptyContext.close();
} finally {
  await browser.close();
}
