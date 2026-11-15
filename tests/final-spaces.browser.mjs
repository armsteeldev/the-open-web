import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPEN_WEB_TEST_URL;
const databasePath = process.env.OPEN_WEB_TEST_DB;
if (!base || !databasePath) throw Error('Final space browser review needs an isolated site and database');
const screenshots = process.env.FINAL_SPACES_SCREENSHOT_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const errors = [];
const externalRequests = [];

async function shot(page, name) {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

async function open(context, path) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(path + ': ' + error.message));
  page.on('console', message => {
    const expectedGardenCooldown = path === '/garden' && page.__expectedGardenCooldowns > 0 && message.text().includes('status of 429 (Too Many Requests)');
    if (expectedGardenCooldown) page.__expectedGardenCooldowns -= 1;
    if (message.type() === 'error' && !message.text().includes('WebSocket') && !expectedGardenCooldown) errors.push(path + ': ' + message.text());
  });
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(base).origin) externalRequests.push(request.url());
  });
  await page.goto(base + path);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  return page;
}

function seed(work) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    work(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function waitForScene(page, selector, message) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.getByText(message, { exact: true }).waitFor();
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  await desktop.addInitScript(() => {
    window.__geolocationCalls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get() {
        window.__geolocationCalls += 1;
        return { getCurrentPosition() {}, watchPosition() {} };
      },
    });
  });

  // Drawing Board: a blank page is the tool, then sketches become discoverable objects.
  const draw = await open(desktop, '/draw');
  await draw.getByRole('heading', { name: 'The Drawing Board' }).waitFor();
  await waitForScene(draw, '#draw-surface', 'Draw with a mouse, finger or pen. For keyboard drawing, focus the paper: arrow keys move, Space starts or extends a line, and Escape ends it.');
  await shot(draw, 'drawing-board-blank-desktop.png');
  await draw.getByRole('button', { name: 'Browse' }).click();
  await draw.getByText('No drawings left yet. Make the first one.', { exact: true }).waitFor();
  await shot(draw, 'drawing-board-gallery-empty-desktop.png');
  await draw.getByRole('button', { name: 'Draw', exact: true }).click();

  const paper = draw.locator('#draw-surface');
  await paper.focus();
  await draw.keyboard.press('ArrowRight');
  await draw.keyboard.press('Space');
  await draw.keyboard.press('ArrowDown');
  await draw.keyboard.press('Space');
  await draw.keyboard.press('Escape');
  assert.equal(await draw.locator('#submit-drawing').isEnabled(), true, 'keyboard drawing can create a stroke');
  await draw.getByRole('button', { name: 'Undo' }).click();
  assert.equal(await draw.locator('#redo-drawing').isEnabled(), true);
  await draw.getByRole('button', { name: 'Redo' }).click();
  await draw.getByRole('button', { name: 'Clear' }).click();
  assert.equal(await draw.locator('#submit-drawing').isEnabled(), false);

  const paperBox = await paper.boundingBox();
  assert.ok(paperBox);
  await draw.mouse.move(paperBox.x + paperBox.width * 0.16, paperBox.y + paperBox.height * 0.22);
  await draw.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await draw.mouse.move(paperBox.x + paperBox.width * (0.16 + step * 0.075), paperBox.y + paperBox.height * (0.22 + step * 0.055));
  }
  await draw.mouse.up();
  await draw.getByRole('button', { name: 'Blue' }).click();
  await draw.mouse.move(paperBox.x + paperBox.width * 0.22, paperBox.y + paperBox.height * 0.76);
  await draw.mouse.down();
  await draw.mouse.move(paperBox.x + paperBox.width * 0.78, paperBox.y + paperBox.height * 0.76);
  await draw.mouse.up();
  await draw.setViewportSize({ width: 768, height: 1024 });
  await draw.waitForFunction(() => {
    const canvas = document.querySelector('#draw-surface');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const pixel = context.getImageData(Math.round(500 * canvas.width / 1000), Math.round(532 * canvas.height / 700), 1, 1).data;
    return pixel[2] > pixel[0] && pixel[0] < 180;
  }, undefined, { timeout: 2000 });
  await draw.setViewportSize({ width: 1365, height: 900 });
  await draw.locator('#draw-surface').waitFor();
  await shot(draw, 'drawing-board-in-progress-desktop.png');
  const drawingResponse = draw.waitForResponse(response => response.url().endsWith('/api/draw/drawings') && response.request().method() === 'POST');
  await draw.getByRole('button', { name: 'Leave it' }).click();
  assert.equal((await drawingResponse).status(), 201);
  await draw.getByRole('button', { name: 'Browse' }).waitFor({ state: 'visible' });
  await draw.locator('.drawing-card').first().waitFor();
  await draw.locator('.drawing-card').first().click();
  await draw.locator('#drawing-viewer[open]').waitFor();
  await shot(draw, 'drawing-board-completed-desktop.png');
  await draw.getByRole('button', { name: 'Close drawing' }).click();

  seed(db => {
    const insert = db.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)');
    const now = Date.now();
    const first = JSON.stringify([{ tool: 'pen', color: 1, size: 2, points: [[100, 500], [250, 250], [500, 500], [750, 250], [900, 500]] }]);
    const second = JSON.stringify([{ tool: 'pen', color: 3, size: 1, points: [[150, 350], [300, 180], [500, 360], [700, 150], [850, 340]] }]);
    insert.run(now - 1, first);
    insert.run(now - 2, second);
  });
  await draw.reload();
  await draw.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await draw.getByRole('button', { name: 'Browse' }).click();
  await draw.locator('.drawing-card').nth(2).waitFor();
  assert.ok(await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(draw, 'drawing-board-gallery-desktop.png');

  // Garden: one participant can give a single plant a clear place in the scene.
  const garden = await open(desktop, '/garden');
  await garden.getByRole('heading', { name: 'The Garden' }).waitFor();
  await garden.locator('#garden-count').getByText('A shared patch of ground', { exact: true }).waitFor();
  await shot(garden, 'garden-empty-desktop.png');
  await garden.locator('#plant-type').selectOption('wildflower');
  const plantingResponse = garden.waitForResponse(response => response.url().endsWith('/api/garden/plants') && response.request().method() === 'POST');
  await garden.getByRole('button', { name: 'Plant it' }).click();
  assert.equal((await plantingResponse).status(), 201);
  await garden.getByText('1 plant growing', { exact: true }).waitFor();
  assert.equal(await garden.getByRole('button', { name: 'Plant it' }).isEnabled(), true, 'the form remains available for a later return after the cooldown');
  await shot(garden, 'garden-new-seed-desktop.png');
  const gardenCooldown = garden.waitForResponse(response => response.url().endsWith('/api/garden/plants') && response.request().method() === 'POST');
  garden.__expectedGardenCooldowns = 1;
  await garden.getByRole('button', { name: 'Plant it' }).click();
  assert.equal((await gardenCooldown).status(), 429);
  await garden.getByText(/You can plant something else in about 30 minutes\./).waitFor();
  assert.equal(await garden.getByRole('button', { name: 'Plant it' }).isEnabled(), true, 'the cooldown does not permanently disable planting');

  const gardenNow = Date.now();
  seed(db => {
    const insert = db.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (?, ?, ?, ?)');
    insert.run(2, 2, 'clover', gardenNow - 60_001);
    insert.run(4, 4, 'sunflower', gardenNow - 30 * 60_000 - 1);
    insert.run(6, 6, 'sapling', gardenNow - 24 * 60 * 60_000);
  });
  await garden.reload();
  await garden.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await garden.getByText('4 plants growing', { exact: true }).waitFor();
  await shot(garden, 'garden-mixed-growth-desktop.png');

  seed(db => {
    const insert = db.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (?, ?, ?, ?)');
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60_000;
    for (let y = 2; y < 6; y++) {
      for (let x = 7; x < 14; x++) insert.run(x, y, (x + y) % 2 ? 'wildflower' : 'sunflower', twoDaysAgo);
    }
  });
  await garden.reload();
  await garden.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await garden.getByText('32 plants growing', { exact: true }).waitFor();
  await shot(garden, 'garden-mature-desktop.png');

  // Visitors Map: all marks are explicit country choices and only aggregates are public.
  const map = await open(desktop, '/map');
  await map.getByRole('heading', { name: 'Visitors Map' }).waitFor();
  await map.locator('#country-shapes path').first().waitFor();
  await map.getByText('No marks yet. Choose a country if you would like to leave one.', { exact: true }).waitFor();
  await shot(map, 'visitors-map-empty-desktop.png');
  seed(db => {
    const insert = db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?)');
    insert.run('a'.repeat(64), 'SE', Date.now());
    insert.run('b'.repeat(64), 'SE', Date.now());
    insert.run('c'.repeat(64), 'SE', Date.now());
    insert.run('d'.repeat(64), 'US', Date.now());
    insert.run('e'.repeat(64), 'JP', Date.now());
    insert.run('f'.repeat(64), 'JP', Date.now());
  });
  await map.reload();
  await map.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await map.locator('#country-shapes path.has-marks').nth(2).waitFor();
  assert.equal(await map.locator('#country-shapes path.has-marks').count(), 3);
  await shot(map, 'visitors-map-populated-desktop.png');
  await map.locator('#country-shapes [data-country="DE"]').click();
  assert.equal(await map.locator('#country-select').inputValue(), 'DE', 'the map itself selects a country');
  await map.locator('#country-select').selectOption('SE');
  await map.getByText('3 marks from Sweden.', { exact: true }).waitFor();
  await shot(map, 'visitors-map-country-selected.png');
  await map.locator('#country-select').selectOption('CA');
  await shot(map, 'visitors-map-contribution-desktop.png');
  const addMapMark = map.waitForResponse(response => response.url().endsWith('/api/map/contribution') && response.request().method() === 'POST');
  await map.getByRole('button', { name: 'Add my country' }).click();
  assert.equal((await addMapMark).status(), 200);
  await map.getByText('Your mark for Canada is on the map.', { exact: true }).waitFor();
  await map.locator('#country-select').selectOption('ES');
  await map.getByRole('button', { name: 'Move my mark here' }).click();
  await map.getByText('Your mark for Spain is on the map.', { exact: true }).waitFor();
  const removeMapMark = map.waitForResponse(response => response.url().endsWith('/api/map/contribution') && response.request().method() === 'POST');
  await map.getByRole('button', { name: 'Remove my mark' }).click();
  assert.equal((await removeMapMark).status(), 200);
  await map.getByText('Your mark has been removed.', { exact: true }).waitFor();

  // Touch interaction and alternative selectors at a narrow viewport.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile.addInitScript(() => {
    window.__geolocationCalls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get() {
        window.__geolocationCalls += 1;
        return { getCurrentPosition() {}, watchPosition() {} };
      },
    });
  });
  const mobileDraw = await open(mobile, '/draw');
  const mobilePaper = await mobileDraw.locator('#draw-surface').boundingBox();
  assert.ok(mobilePaper);
  const cdp = await mobile.newCDPSession(mobileDraw);
  const touch = (x, y) => ({ x: mobilePaper.x + mobilePaper.width * x, y: mobilePaper.y + mobilePaper.height * y, radiusX: 2, radiusY: 2, force: 1, id: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(0.15, 0.2)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(0.42, 0.46)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(0.8, 0.7)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await mobileDraw.locator('#submit-drawing').isEnabled(), true, 'touch can draw without scrolling the page');
  await shot(mobileDraw, 'drawing-board-mobile-interaction.png');
  const mobileDrawing = mobileDraw.waitForResponse(response => response.url().endsWith('/api/draw/drawings') && response.request().method() === 'POST');
  await mobileDraw.getByRole('button', { name: 'Leave it' }).click();
  assert.equal((await mobileDrawing).status(), 201);
  const mobileGarden = await open(mobile, '/garden');
  const mobileGardenCanvas = mobileGarden.locator('#garden-scene');
  const canvasBox = await mobileGardenCanvas.boundingBox();
  assert.ok(canvasBox);
  await mobileGardenCanvas.tap({ position: { x: canvasBox.width * 0.106, y: canvasBox.height * 0.8 } });
  assert.equal(await mobileGarden.locator('#plant-location').inputValue(), '1,0', 'a tap selects an open patch without fine controls');
  await mobileGarden.locator('#plant-type').selectOption('sunflower');
  await shot(mobileGarden, 'garden-mobile-planting-interaction.png');
  const mobilePlant = mobileGarden.waitForResponse(response => response.url().endsWith('/api/garden/plants') && response.request().method() === 'POST');
  await mobileGarden.getByRole('button', { name: 'Plant it' }).click();
  assert.equal((await mobilePlant).status(), 201);
  const mobileMap = await open(mobile, '/map');
  await mobileMap.locator('#country-shapes path').first().waitFor();
  await mobileMap.locator('#country-select').selectOption('NZ');
  await mobileMap.getByText('No marks from New Zealand yet.', { exact: true }).waitFor();
  assert.ok(await mobileMap.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(mobileMap, 'visitors-map-mobile-country-picker.png');
  const mobileMark = mobileMap.waitForResponse(response => response.url().endsWith('/api/map/contribution') && response.request().method() === 'POST');
  await mobileMap.getByRole('button', { name: 'Add my country' }).click();
  assert.equal((await mobileMark).status(), 200);

  // Exercise all required viewport classes on every route, including narrow landscape.
  for (const viewport of [
    { width: 1365, height: 900, touch: false },
    { width: 1920, height: 1080, touch: false },
    { width: 768, height: 1024, touch: true },
    { width: 320, height: 640, touch: true },
    { width: 844, height: 390, touch: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.width < 500,
    });
    for (const route of ['/draw', '/garden', '/map']) {
      const page = await open(context, route);
      await page.getByRole('heading', { name: route === '/draw' ? 'The Drawing Board' : route === '/garden' ? 'The Garden' : 'Visitors Map' }).waitFor();
      await page.locator('.global-menu > summary').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), viewport.width + 'px ' + route + ' has no horizontal overflow');
      if (route === '/draw') {
        const rect = await page.locator('#draw-surface').boundingBox();
        assert.ok(rect && rect.width >= 290 && rect.height > 0, viewport.width + 'px drawing surface is usable');
      } else if (route === '/garden') {
        assert.ok(await page.locator('#plant-submit').isVisible());
      } else {
        assert.ok(await page.locator('#country-select').isVisible());
        assert.ok((await page.locator('#country-select option').count()) >= 240);
      }
      await page.close();
    }
    await context.close();
    console.log('PASS final spaces viewport ' + viewport.width + 'x' + viewport.height);
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'map, drawings, and garden make no third-party requests');
  assert.equal(await map.evaluate(() => window.__geolocationCalls), 0, 'Visitors Map never accesses browser geolocation');
  assert.equal(await mobileMap.evaluate(() => window.__geolocationCalls), 0, 'mobile Visitors Map never accesses browser geolocation');
  const mapTexts = await map.locator('body').innerText();
  assert.equal(/live visitors|visitor tracking|geolocation/i.test(mapTexts), false);
  await desktop.close();
  await mobile.close();
  await browser.close();
  console.log('PASS Drawing Board, Garden and Visitors Map interactions, privacy, touch, keyboard and saved screenshots');
} catch (error) {
  await browser.close();
  throw error;
}
