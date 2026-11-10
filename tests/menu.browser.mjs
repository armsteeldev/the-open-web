import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL; if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; browser tests can modify its database');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
 for(const viewport of [{width:1000,height:700},{width:320,height:640}]) {
  const context=await browser.newContext({viewport,hasTouch:viewport.width<500}); const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/wall');const menu=page.locator('.global-menu[data-top-disclosure]'),trigger=page.getByLabel('Spaces',{exact:true}).first(),panel=page.locator('#global-menu-panel');
  assert.equal(await menu.evaluate(e=>e.open),false);await trigger.click();assert.equal(await menu.evaluate(e=>e.open),true);
  assert.equal(await page.getByText('The Open Web',{exact:true}).isVisible(),true);assert.equal(await panel.locator('img').count(),0);assert.equal(await panel.getByText('A project by Armsteel').count(),0);
  assert.equal(await panel.getByRole('link',{name:'The Wall'}).getAttribute('aria-current'),'page');const rect=await panel.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=viewport.width);
  await page.keyboard.press('Escape');assert.equal(await menu.evaluate(e=>e.open),false);assert.equal(await trigger.evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press('Enter');assert.equal(await menu.evaluate(e=>e.open),true);await page.keyboard.press('Tab');assert.equal(await panel.getByRole('link').evaluate(e=>document.activeElement===e),true);
  let placements=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/wall/pixel'))placements++;});await page.mouse.click(viewport.width-30,100);assert.equal(await menu.evaluate(e=>e.open),false);assert.equal(placements,0);
  await trigger.click();await panel.getByRole('link',{name:'The Wall'}).click();await page.waitForURL('**/wall');assert.equal(await menu.evaluate(e=>e.open),false);assert.deepEqual(errors,[]);await context.close();
 }
 console.log('Menu desktop and mobile: disclosure, simple label, active link, keyboard, dismiss and navigation passed');
}finally{await browser.close()}
