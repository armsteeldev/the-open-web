import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL; if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; browser tests can modify its database');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
const errors=[];
try {
 const a=await browser.newContext({viewport:{width:1000,height:700}}),b=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 const p=await a.newPage(),q=await b.newPage();p.on('pageerror',e=>errors.push(e.message));q.on('pageerror',e=>errors.push(e.message));
 await Promise.all([p.goto(base+'/wall'),q.goto(base+'/wall')]);
 await Promise.all([p.getByText('Ready',{exact:true}).waitFor(),q.getByText('Ready',{exact:true}).waitFor()]);
 const existing=await p.evaluate(async()=>new Uint8Array(await (await fetch('/api/wall/tile/10/10')).arrayBuffer())[0]); const color=existing===4?5:4; const button=p.locator(`[data-color="${color}"]`); await button.click();assert.equal(await button.getAttribute('aria-pressed'),'true');
 await p.locator('canvas').click({position:{x:500,y:350}});
 await p.getByText(/^[1-9]\d?s$/).waitFor();
 await q.waitForFunction((color) => { const c=document.querySelector('canvas'); const d=c.getContext('2d').getImageData(Math.floor(innerWidth/2),Math.floor(innerHeight/2),1,1).data; return color===4 ? d[0]===229 && d[1]===57 && d[2]===53 : d[0]===255 && d[1]===152 && d[2]===0; },color); await p.screenshot({path:'/tmp/open-web-desktop.png'}); await q.screenshot({path:'/tmp/open-web-mobile.png'});let tile=await q.evaluate(async()=>[...new Uint8Array(await (await fetch('/api/wall/tile/10/10')).arrayBuffer())]);assert.equal(tile[0],color);
 await p.reload();await p.getByText('Ready',{exact:true}).waitFor({timeout:15000}).catch(async()=>{await p.locator('#status').waitFor();});
 await q.locator('#plus').click();await q.locator('canvas').dispatchEvent('pointerdown',{pointerId:1,pointerType:'touch',clientX:180,clientY:300});await q.locator('canvas').dispatchEvent('pointermove',{pointerId:1,pointerType:'touch',clientX:200,clientY:320});await q.locator('canvas').dispatchEvent('pointerup',{pointerId:1,pointerType:'touch',clientX:200,clientY:320});
 assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);console.log('Desktop placement, mobile viewport, colour selection, refresh and tile state passed');
} finally {await browser.close();}
