import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.OPEN_WEB_TEST_URL;
const api = process.env.OPEN_WEB_TEST_API;
if (!base || !api) throw Error('The chat recovery test requires an isolated web and API instance');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.addInitScript(() => { Math.random = () => 0.5; });
  const attempts = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/chat/history', async route => {
    attempts.push(performance.now());
    if (attempts.length <= 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' });
      return;
    }
    await route.continue();
  });

  await page.goto(`${base}/chat`);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.getByText('Restoring history', { exact: true }).waitFor();

  const address = '198.51.100.245';
  const session = await fetch(`${api}/api/chat/history`, { headers: { 'x-forwarded-for': address } });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
  const message = `Buffered during history outage ${randomUUID()}`;
  const submission = await fetch(`${api}/api/chat/messages`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify({ requestId: randomUUID(), nickname: 'Recovery check', text: message }),
  });
  assert.equal(submission.status, 200);

  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 12_000 });
  await page.getByText(message, { exact: true }).waitFor();
  assert.equal(attempts.length, 3, `history request attempts: ${attempts.length}`);
  const delays = [attempts[1] - attempts[0], attempts[2] - attempts[1]];
  assert.ok(delays[0] >= 1_200, `first retry delay was too short: ${delays[0]}ms`);
  assert.ok(delays[1] >= 2_400, `second retry did not back off: ${delays[1]}ms`);
  assert.ok(delays[1] > delays[0] * 1.5, `retry intervals did not increase: ${JSON.stringify(delays)}`);
  assert.deepEqual(errors, []);
  console.log(`PASS chat history recovery with buffered event and retry delays ${delays.map(delay => Math.round(delay)).join('ms, ')}ms`);
  await context.close();
} finally {
  await browser.close();
}
