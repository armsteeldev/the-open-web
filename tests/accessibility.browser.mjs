import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';

const base=process.env.OPEN_WEB_TEST_URL;
if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
 for(const viewport of [{width:1280,height:800},{width:390,height:844}]) {
  const context=await browser.newContext({viewport,hasTouch:viewport.width<500});
  const page=await context.newPage();
  await page.goto(base+'/wall');
  await page.addStyleTag({content:'astro-dev-toolbar{display:none!important}'});
  const initial=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  assert.deepEqual(initial.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
  await page.getByLabel('Spaces',{exact:true}).first().click();
  const menu=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  assert.deepEqual(menu.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
  await context.close();
 }
 console.log('PASS axe WCAG 2.1 A/AA checks on desktop, mobile and open menu');
} finally {await browser.close();}
