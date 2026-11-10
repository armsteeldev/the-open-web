import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.OPEN_WEB_TEST_URL;
const api = process.env.OPEN_WEB_TEST_API;
if (!base || !api) throw Error('The chat browser test requires an isolated web and API instance');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
let ipCounter = 1;
const network = () => `198.51.${100 + Math.floor(ipCounter / 254)}.${1 + (ipCounter++ % 254)}`;

async function visitor() {
  const ip = network();
  const response = await fetch(`${api}/api/chat/history`, { headers: { 'x-forwarded-for': ip } });
  assert.equal(response.status, 200);
  return { ip, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
}

async function send(text, nickname = 'Load visitor') {
  const { ip, cookie } = await visitor();
  const response = await fetch(`${api}/api/chat/messages`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ requestId: randomUUID(), nickname, text }),
  });
  return { response, result: await response.json() };
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const recordConsoleError = message => { if (message.type() === 'error') errors.push(message.text()); };
  page.on('console', recordConsoleError);
  let releaseHistory;
  let snapshotCaptured;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const captured = new Promise(resolve => { snapshotCaptured = resolve; });
  await page.route('**/api/chat/history', async route => {
    const response = await route.fetch();
    snapshotCaptured();
    await historyGate;
    await route.fulfill({ response });
  });
  await page.goto(`${base}/chat`);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.getByText('Synchronizing', { exact: true }).waitFor();
  await captured;
  const race = await send('Arrived between snapshot and live display');
  assert.equal(race.response.status, 200);
  assert.equal(await page.locator('.message .text').count(), 0);
  releaseHistory();
  await page.getByText('Arrived between snapshot and live display', { exact: true }).waitFor();
  await page.getByText('Connected', { exact: true }).waitFor();
  assert.match(await page.locator('.message time').first().textContent(), /^\d{2}:\d{2} UTC$/);
  await page.unrouteAll({ behavior: 'wait' });

  const menu = page.locator('.global-menu');
  await page.getByLabel('Spaces', { exact: true }).first().click();
  assert.equal(await menu.locator('a').count(), 2);
  assert.equal(await menu.getByRole('link', { name: 'Global Chat' }).getAttribute('aria-current'), 'page');
  await page.keyboard.press('Escape');

  await page.getByLabel('Nickname', { exact: true }).fill('<img src=x>');
  await page.getByLabel('Message', { exact: true }).fill('<script>window.chatInjected=true</script>');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('<script>window.chatInjected=true</script>', { exact: true }).waitFor();
  assert.equal(await page.getByText('<script>window.chatInjected=true</script>', { exact: true }).count(), 1);
  assert.equal(await page.locator('#messages img, #messages script').count(), 0);
  assert.equal(await page.evaluate(() => window.chatInjected), undefined);
  assert.equal(await page.locator('.nickname').last().textContent(), '<img src=x>:');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Enter a message before sending.', { exact: true }).waitFor();
  await page.getByLabel('Nickname', { exact: true }).press('Tab');
  assert.equal(await page.evaluate(() => localStorage.getItem('the-open-web.chat.nickname')), '<img src=x>');
  page.off('console', recordConsoleError);
  await page.route('**/api/chat/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"writes disabled"}' }));
  await page.getByLabel('Message', { exact: true }).fill('Draft survives a temporary send failure');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Sending is temporarily disabled. Your text is still here.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Draft survives a temporary send failure');
  await page.unrouteAll({ behavior: 'wait' });
  page.on('console', recordConsoleError);

  const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const reader = await readerContext.newPage();
  const readerErrors = [];
  reader.on('pageerror', error => readerErrors.push(error.message));
  await reader.addInitScript(() => {
    window.__testSockets = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        window.__testSockets.push(socket);
        return socket;
      },
    });
  });
  await reader.goto(`${base}/chat`);
  await reader.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await reader.getByText('Connected', { exact: true }).waitFor();
  await reader.getByText('<script>window.chatInjected=true</script>', { exact: true }).waitFor();

  for (let i = 0; i < 88; i++) {
    const result = await send(`History line ${String(i).padStart(3, '0')}`);
    assert.equal(result.response.status, 200, `seed message ${i}: ${JSON.stringify(result.result)}`);
  }
  await reader.reload();
  await reader.getByText('Connected', { exact: true }).waitFor();
  const region = reader.locator('#message-region');
  await reader.waitForFunction(() => document.querySelector('#message-region').scrollHeight > document.querySelector('#message-region').clientHeight);
  await region.evaluate(element => { element.scrollTop = 0; });
  const oldTop = await region.evaluate(element => element.scrollTop);
  const arriving = await send('New message while reading above');
  assert.equal(arriving.response.status, 200);
  await reader.getByText('New message while reading above', { exact: true }).waitFor();
  assert.equal(await region.evaluate(element => element.scrollTop), oldTop);
  await reader.getByRole('button', { name: /Return to newest messages/ }).click();
  assert.equal(await reader.locator('#newest').isHidden(), true);
  await reader.waitForFunction(() => { const element = document.querySelector('#message-region'); return element.scrollHeight - element.scrollTop - element.clientHeight <= 4; });

  await region.evaluate(element => { element.scrollTop = 0; });
  const disconnectedScroll = await region.evaluate(element => element.scrollTop);
  await readerContext.setOffline(true);
  await reader.evaluate(() => window.__testSockets.at(-1)?.close(4000, 'isolated reconnect check'));
  await reader.getByText(/Disconnected|reconnecting/i).waitFor({ timeout: 10_000 });
  const missed = await send('Sent while this browser was disconnected');
  assert.equal(missed.response.status, 200);
  await readerContext.setOffline(false);
  await reader.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
  await reader.getByText('Sent while this browser was disconnected', { exact: true }).waitFor();
  await reader.getByRole('button', { name: /Return to newest messages/ }).waitFor();
  assert.equal(await region.evaluate(element => element.scrollTop), disconnectedScroll);

  await reader.setViewportSize({ width: 320, height: 640 });
  assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const composer = await reader.locator('#composer').boundingBox();
  const viewport = await reader.evaluate(() => ({ height: visualViewport?.height ?? innerHeight, top: visualViewport?.offsetTop ?? 0 }));
  assert.ok(composer.y + composer.height <= viewport.top + viewport.height + 1);
  await reader.getByLabel('Message', { exact: true }).focus();
  await reader.setViewportSize({ width: 320, height: 400 });
  const keyboardComposer = await reader.locator('#composer').boundingBox();
  assert.ok(keyboardComposer.y + keyboardComposer.height <= 401);
  await reader.getByLabel('Message', { exact: true }).fill('Keyboard send works on a narrow screen');
  await reader.getByLabel('Message', { exact: true }).press('Enter');
  await reader.getByText('Keyboard send works on a narrow screen', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(readerErrors, []);
  await context.close();
  await readerContext.close();
  console.log('PASS chat snapshot/event race, plain-text rendering, history, live scroll, reconnect recovery, keyboard and narrow mobile layout');
} finally {
  await browser.close();
}
