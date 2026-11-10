import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPEN_WEB_TEST_URL;
const api = process.env.OPEN_WEB_TEST_API;
if (!base || !api) throw Error('The chat browser test requires an isolated web and API instance');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const screenshotDir = process.env.CHAT_SCREENSHOT_DIR;
let ipCounter = 1;
const network = () => `198.51.${100 + Math.floor(ipCounter / 254)}.${1 + (ipCounter++ % 254)}`;

async function screenshot(page, name) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.evaluate(() => document.querySelector('astro-dev-toolbar')?.remove());
  await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
}

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Pacific/Honolulu' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const recordConsoleError = message => { if (message.type() === 'error') errors.push(message.text()); };
  page.on('console', recordConsoleError);
  await page.goto(`${base}/chat`);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.getByText('Connected', { exact: true }).waitFor();
  assert.match(await page.locator('#identity-label').textContent(), /^Anonymous\d{9}$/);
  assert.match(await page.locator('#empty-state .empty-title').textContent(), /quiet/i);
  await screenshot(page, 'desktop-empty.png');
  const stableIdentity = await page.locator('#identity-label').textContent();
  await page.reload();
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.getByText('Connected', { exact: true }).waitFor();
  assert.equal(await page.locator('#identity-label').textContent(), stableIdentity);

  const emptyMobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const emptyMobile = await emptyMobileContext.newPage();
  const emptyMobileErrors = [];
  emptyMobile.on('pageerror', error => emptyMobileErrors.push(error.message));
  await emptyMobile.goto(`${base}/chat`);
  await emptyMobile.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await emptyMobile.getByText('Connected', { exact: true }).waitFor();
  await screenshot(emptyMobile, 'mobile-empty.png');
  const mobileMenuBox = await emptyMobile.locator('.global-menu').boundingBox();
  const mobileRoomBox = await emptyMobile.locator('.chat-room').boundingBox();
  assert.ok(mobileMenuBox && mobileRoomBox && mobileMenuBox.y >= 0 && mobileMenuBox.y + mobileMenuBox.height <= mobileRoomBox.y, 'the shared spaces menu stays visible above the mobile chat room');

  const raceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const racePage = await raceContext.newPage();
  let releaseHistory;
  let snapshotCaptured;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const captured = new Promise(resolve => { snapshotCaptured = resolve; });
  await racePage.route('**/api/chat/history', async route => {
    const response = await route.fetch();
    snapshotCaptured();
    await historyGate;
    await route.fulfill({ response });
  });
  await racePage.goto(`${base}/chat`);
  await racePage.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await racePage.getByText('Synchronizing', { exact: true }).waitFor();
  await captured;
  const race = await send('Arrived between snapshot and live display');
  assert.equal(race.response.status, 200);
  await page.getByText('Arrived between snapshot and live display', { exact: true }).waitFor();
  await screenshot(emptyMobile, 'mobile-one-message.png');
  assert.equal(await racePage.locator('.message .text').count(), 0);
  releaseHistory();
  await racePage.getByText('Arrived between snapshot and live display', { exact: true }).waitFor();
  await racePage.getByText('Connected', { exact: true }).waitFor();
  await racePage.unrouteAll({ behavior: 'wait' });
  await raceContext.close();
  assert.deepEqual(emptyMobileErrors, []);
  await emptyMobileContext.close();
  assert.match(await page.locator('#identity-label').textContent(), /^Anonymous\d{9}$/);
  const timestamp = page.locator('.message time').first();
  assert.doesNotMatch(await timestamp.textContent(), /UTC/);
  assert.equal(await timestamp.evaluate(element => {
    const date = new Date(element.dateTime);
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    const now = new Date();
    const isToday = now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth() && now.getDate() === date.getDate();
    return isToday ? clock : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)} ${clock}`;
  }), await timestamp.textContent());
  await screenshot(page, 'desktop-one-message.png');

  const menu = page.locator('.global-menu');
  const menuBox = await menu.boundingBox();
  const roomBox = await page.locator('.chat-room').boundingBox();
  assert.ok(menuBox && roomBox && menuBox.y >= 0 && menuBox.y + menuBox.height <= roomBox.y, 'the shared spaces menu stays visible above the chat room');
  await page.getByLabel('Spaces', { exact: true }).first().click();
  assert.equal(await menu.locator('a').count(), 2);
  assert.equal(await menu.getByRole('link', { name: 'Global Chat' }).getAttribute('aria-current'), 'page');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Change/ }).click();
  await page.locator('#nickname-dialog').waitFor({ state: 'visible' });
  await screenshot(page, 'desktop-nickname-editor.png');
  await page.locator('#nickname').fill('<img src=x>');
  await page.getByRole('button', { name: 'Save nickname' }).click();
  assert.match(await page.locator('#identity-label').textContent(), /^<img src=x> · #\d{3} \d{3} \d{3}$/);
  assert.equal(await page.locator('.message .nickname').first().textContent(), 'Load visitor');
  await page.getByLabel('Message', { exact: true }).fill('<script>window.chatInjected=true</script>');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('<script>window.chatInjected=true</script>', { exact: true }).waitFor();
  assert.equal(await page.getByText('<script>window.chatInjected=true</script>', { exact: true }).count(), 1);
  assert.equal(await page.locator('#messages img, #messages script').count(), 0);
  assert.equal(await page.evaluate(() => window.chatInjected), undefined);
  assert.equal(await page.locator('.nickname').last().textContent(), '<img src=x>');
  assert.match(await page.locator('.identity-tag').last().textContent(), /^· #\d{3} \d{3} \d{3}$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('the-open-web.chat.nickname')), '<img src=x>');
  await page.getByRole('button', { name: /Change/ }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#nickname-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'identity-button');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Write a message before sending.', { exact: true }).waitFor();
  page.off('console', recordConsoleError);
  await page.route('**/api/chat/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"writes disabled"}' }));
  await page.getByLabel('Message', { exact: true }).fill('Draft survives a temporary send failure');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Sending is temporarily paused. Your draft is still here.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Draft survives a temporary send failure');
  await screenshot(page, 'desktop-send-error.png');
  await page.unrouteAll({ behavior: 'wait' });

  let finishPending;
  const pendingGate = new Promise(resolve => { finishPending = resolve; });
  await page.route('**/api/chat/messages', async route => {
    await pendingGate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"writes disabled"}' });
  });
  await page.getByLabel('Message', { exact: true }).fill('A pending message remains in the composer');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Sending…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Send/ }).isDisabled(), true);
  await screenshot(page, 'desktop-send-pending.png');
  finishPending();
  await page.getByText('Sending is temporarily paused. Your draft is still here.', { exact: true }).waitFor();
  await page.unrouteAll({ behavior: 'wait' });

  await page.route('**/api/chat/messages', route => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"cooldown","retryAfterMs":3000}' }));
  await page.getByLabel('Message', { exact: true }).fill('Cooldown keeps this draft');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText(/Wait about \d seconds\. Your draft stays here\./).waitFor();
  assert.equal(await page.getByRole('button', { name: /Send/ }).isDisabled(), true);
  await screenshot(page, 'desktop-cooldown.png');
  await page.getByText('You can send again. Your draft is still here.', { exact: true }).waitFor({ timeout: 5_000 });
  await page.unrouteAll({ behavior: 'wait' });
  page.on('console', recordConsoleError);

  const longText = `https://example.test/${'unbroken-word-'.repeat(17)} 👩‍💻 café 世界`;
  const longResult = await send(longText, 'International🌙Name');
  assert.equal(longResult.response.status, 200);
  await page.getByText(longText, { exact: true }).waitFor();
  assert.ok(await page.locator('.identity-tag').last().textContent());
  assert.equal(await page.locator('#messages a, #messages iframe, #messages img').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const longNickname = 'abcdefghijklmnopqrstuvwx';
  const longNameResult = await send('A long nickname still fits its sender row', longNickname);
  assert.equal(longNameResult.response.status, 200);
  await page.getByText('A long nickname still fits its sender row', { exact: true }).waitFor();
  assert.equal(await page.locator('.nickname').last().textContent(), longNickname);
  await screenshot(page, 'desktop-long-nickname.png');

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
  await screenshot(page, 'desktop-conversation.png');
  await reader.reload();
  await reader.getByText('Connected', { exact: true }).waitFor();
  await screenshot(reader, 'mobile-conversation.png');
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
  assert.ok(Math.abs((await region.evaluate(element => element.scrollTop)) - disconnectedScroll) <= 2);

  await reader.setViewportSize({ width: 320, height: 640 });
  await reader.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-viewport-height')) - (visualViewport?.height ?? innerHeight)) < 1);
  assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(reader, 'mobile-320.png');
  const composer = await reader.locator('#composer').boundingBox();
  const viewport = await reader.evaluate(() => ({ height: visualViewport?.height ?? innerHeight, top: visualViewport?.offsetTop ?? 0 }));
  assert.ok(composer.y + composer.height <= viewport.top + viewport.height + 1, JSON.stringify({ composer, viewport }));
  await reader.getByLabel('Message', { exact: true }).focus();
  await reader.setViewportSize({ width: 320, height: 400 });
  await reader.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-viewport-height')) - (visualViewport?.height ?? innerHeight)) < 1);
  const keyboardComposer = await reader.locator('#composer').boundingBox();
  const keyboardViewport = await reader.evaluate(() => ({ height: visualViewport?.height ?? innerHeight, top: visualViewport?.offsetTop ?? 0 }));
  assert.ok(keyboardComposer.y + keyboardComposer.height <= keyboardViewport.top + keyboardViewport.height + 1, JSON.stringify({ keyboardComposer, keyboardViewport }));
  await reader.getByLabel('Message', { exact: true }).fill('Keyboard send works on a narrow screen');
  await reader.getByLabel('Message', { exact: true }).press('Enter');
  await reader.getByText('Keyboard send works on a narrow screen', { exact: true }).waitFor();
  await reader.setViewportSize({ width: 844, height: 390 });
  await reader.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-viewport-height')) - (visualViewport?.height ?? innerHeight)) < 1);
  assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const landscapeComposer = await reader.locator('#composer').boundingBox();
  const landscapeViewport = await reader.evaluate(() => ({ height: visualViewport?.height ?? innerHeight, top: visualViewport?.offsetTop ?? 0 }));
  assert.ok(landscapeComposer.y + landscapeComposer.height <= landscapeViewport.top + landscapeViewport.height + 1);
  await screenshot(reader, 'mobile-landscape.png');
  assert.deepEqual(errors, []);
  assert.deepEqual(readerErrors, []);
  await context.close();
  await readerContext.close();
  console.log('PASS chat snapshot/event race, plain-text rendering, history, live scroll, reconnect recovery, keyboard and narrow mobile layout');
} finally {
  await browser.close();
}
