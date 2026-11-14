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
  for(const path of ['/wall','/chat','/bottle']) {
   await page.goto(base+path);
   await page.addStyleTag({content:'astro-dev-toolbar{display:none!important}'});
   if(path==='/chat') await page.getByText('Connected',{exact:true}).waitFor();
    if(path==='/bottle') await page.getByRole('heading',{name:'Message in a Bottle'}).waitFor();
   const initial=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
   assert.deepEqual(initial.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
   if(path==='/chat') {
    const sampleMessage=`Accessibility check message ${viewport.width}`;
    const sent=await page.evaluate(async text=>fetch('/api/chat/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),nickname:'Mira',text})}).then(response=>response.status),sampleMessage);
    assert.equal(sent,200);
    await page.locator('#messages').getByText(sampleMessage,{exact:true}).waitFor();
    const populated=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    assert.deepEqual(populated.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
    await page.getByRole('button',{name:/Change nickname$/}).click();
    const editor=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    assert.deepEqual(editor.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
    await page.keyboard.press('Escape');
   }
    if(path==='/bottle') {
     const bottle=await page.evaluate(async text=>fetch('/api/bottle/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),message:text})}).then(response=>response.status),`Accessibility bottle ${viewport.width}`);
     assert.equal(bottle,200);
     await page.getByRole('button',{name:'Find a bottle'}).click();
     await page.getByText(`Accessibility bottle ${viewport.width}`,{exact:true}).first().waitFor();
     const populated=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
     assert.deepEqual(populated.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
    }
   await page.getByLabel('Spaces',{exact:true}).first().click();
   const menu=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
   assert.deepEqual(menu.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>n.target)})),[]);
  }
  await context.close();
 }
 console.log('PASS axe WCAG 2.1 A/AA checks on desktop, mobile and open menu');
} finally {await browser.close();}
