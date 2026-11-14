import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.OPEN_WEB_TEST_URL;
if (!base) throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const redirect = await page.request.get(`${base}/`, { maxRedirects: 0 });
  assert.equal(redirect.status(), 302);
  assert.equal(redirect.headers().location, '/wall/');
  const wallRedirect = await page.request.get(`${base}/wall`, { maxRedirects: 0 });
  assert.equal(wallRedirect.status(), 308);
  assert.equal(wallRedirect.headers().location, '/wall/');
  const chatRedirect = await page.request.get(`${base}/chat`, { maxRedirects: 0 });
  assert.equal(chatRedirect.status(), 308);
  assert.equal(chatRedirect.headers().location, '/chat/');
  const bottleRedirect = await page.request.get(`${base}/bottle`, { maxRedirects: 0 });
  assert.equal(bottleRedirect.status(), 308);
  assert.equal(bottleRedirect.headers().location, '/bottle/');

  const response = await page.goto(`${base}/wall/`);
  assert.match(response.headers()['content-security-policy'], /default-src 'self'/);
  await page.getByText('Ready', { exact: true }).waitFor({ timeout: 15000 });
  const paletteBox = await page.locator('#palette').boundingBox();
  const toolsBox = await page.locator('.tools').boundingBox();
  assert.ok(paletteBox && paletteBox.x >= 0 && paletteBox.y + paletteBox.height <= 700);
  assert.ok(toolsBox && toolsBox.x >= 0 && toolsBox.x + toolsBox.width <= 1000);
  const cookie = (await context.cookies()).find(item => item.name === 'ow_id');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');

  await page.locator('.global-menu > summary').click();
  assert.equal(await page.getByText('The Open Web', { exact: true }).isVisible(), true);
  // Exercise a fresh 12-token network budget. No earlier UI placement should
  // consume a token, and the limits remain the same as production.
  const visitors = await Promise.all(Array.from({ length: 13 }, async () => {
    const visitor = await browser.newContext({ ignoreHTTPSErrors: true });
    const visitorPage = await visitor.newPage();
    const session = await visitorPage.request.get(`${base}/api/session`);
    assert.equal(session.status(), 200);
    return { visitor, page: visitorPage };
  }));
  const writes = await Promise.all(visitors.map(({ page: visitorPage }, index) => visitorPage.request.post(`${base}/api/wall/pixel`, {
    headers: {
      origin: new URL(base).origin,
      'x-forwarded-for': `198.51.100.${index + 1}`,
      'x-real-ip': `203.0.113.${index + 1}`,
      'content-type': 'application/json',
    },
    data: JSON.stringify({ x: 100 + index, y: 100, color: 2 }),
  })));
  assert.equal(writes.filter(result => result.status() === 200).length, 12);
  const limited = writes.filter(result => result.status() === 429);
  assert.equal(limited.length, 1);
  const retryAfterValues = await Promise.all(limited.map(async result => {
    const body = await result.json();
    assert.equal(body.ok, false);
    assert.ok(Number.isFinite(body.retryAfterMs) && body.retryAfterMs > 0);
    return body.retryAfterMs;
  }));
  await Promise.all(visitors.map(({ visitor }) => visitor.close()));

  // The rate limiter refills at one token per second; wait for that next token
  // before checking the independent UI placement path.
  await page.waitForTimeout(Math.max(...retryAfterValues) + 50);
  await page.locator('[data-color="4"]').click();
  const placed = page.waitForResponse(result => result.url().endsWith('/api/wall/pixel') && result.request().method() === 'POST');
  await page.locator('canvas').click({ position: { x: 504, y: 354 } });
  assert.equal((await placed).status(), 200);

  await page.goto(`${base}/chat/`);
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 15000 });
  await page.locator('.global-menu > summary').click();
  assert.equal(await page.locator('.global-menu nav a').count(), 3);
  assert.equal(await page.locator('.global-menu nav a[aria-current="page"]').textContent(), 'Global Chat');
  await page.keyboard.press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('compiled HTTPS chat smoke');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('compiled HTTPS chat smoke', { exact: true }).waitFor();

  await page.goto(`${base}/bottle/`);
  await page.getByRole('heading', { name: 'Message in a Bottle' }).waitFor();
  await page.getByLabel('Leave one').fill('compiled HTTPS bottle smoke');
  await page.getByRole('button', { name: 'Release bottle' }).click();
  await page.getByText(/Bottle released\. You can leave another bottle in \d+ seconds?\./).waitFor();
  const bottleReaderContext = await browser.newContext({ viewport: { width: 1000, height: 700 }, ignoreHTTPSErrors: true });
  const bottleReader = await bottleReaderContext.newPage();
  await bottleReader.goto(`${base}/bottle/`);
  await bottleReader.getByRole('button', { name: 'Find a bottle' }).click();
  await bottleReader.getByText('compiled HTTPS bottle smoke', { exact: true }).waitFor();
  await bottleReader.locator('.global-menu > summary').click();
  assert.equal(await bottleReader.locator('.global-menu nav a').count(), 3);
  assert.equal(await bottleReader.locator('.global-menu nav a[aria-current="page"]').textContent(), 'Message in a Bottle');
  await bottleReaderContext.close();

  assert.deepEqual(errors, []);
  if (process.env.OPEN_WEB_SCREENSHOT) {
    const layout = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight],
      palette: document.querySelector('#palette').getBoundingClientRect().toJSON(),
      tools: document.querySelector('.tools').getBoundingClientRect().toJSON(),
      menuOpen: document.querySelector('.global-menu[data-top-disclosure]').open,
    }));
    console.log(JSON.stringify(layout));
    await page.screenshot({ path: process.env.OPEN_WEB_SCREENSHOT });
  }
  console.log('PASS compiled app over isolated HTTPS Caddy: CSP, Secure cookie, WSS, routing, menu, spoofed proxy-header rejection');
} finally {
  await browser.close();
}
