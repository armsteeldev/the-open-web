import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL; if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; browser tests can modify its database');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try{
 const a=await browser.newContext({viewport:{width:1000,height:700}}),b=await browser.newContext({viewport:{width:1000,height:700}});const p=await a.newPage(),q=await b.newPage();let errors=[];p.on('pageerror',e=>errors.push(e.message));q.on('pageerror',e=>errors.push(e.message));
 await Promise.all([p.goto(base+'/wall'),q.goto(base+'/wall')]);await Promise.all([p.getByText('Ready',{exact:true}).waitFor(),q.getByText('Ready',{exact:true}).waitFor()]);
 await p.locator('[data-color="4"]').click();await p.mouse.move(504,354);assert.match(await p.locator('#coords').innerText(),/1000, 1000/);
 const before=await p.evaluate(async()=>new Uint8Array(await (await fetch('/api/wall/tile/10/10')).arrayBuffer())[0]);assert.equal(before,0);
 const response=p.waitForResponse(r=>r.url().endsWith('/api/wall/pixel')&&r.request().method()==='POST');await p.mouse.click(504,354);assert.equal((await response).status(),200);
 await q.waitForFunction(()=>{let d=document.querySelector('canvas').getContext('2d').getImageData(504,354,1,1).data;return d[0]===229&&d[1]===57&&d[2]===53});
 const saved=await q.evaluate(async()=>new Uint8Array(await (await fetch('/api/wall/tile/10/10')).arrayBuffer())[0]);assert.equal(saved,4);
 const denied=await p.evaluate(async()=>{let r=await fetch('/api/wall/pixel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:1001,y:1000,color:2})});return r.status});assert.equal(denied,429);
 await q.reload();await q.getByText('Ready',{exact:true}).waitFor();await q.waitForFunction(()=>{let d=document.querySelector('canvas').getContext('2d').getImageData(504,354,1,1).data;return d[0]===229&&d[1]===57});
 await p.mouse.move(650,400);const coords=await p.locator('#coords').innerText();await p.mouse.wheel(0,-200);assert.equal(await p.locator('#coords').innerText(),coords);
 await p.mouse.move(700,450);await p.mouse.down();await p.mouse.move(740,480,{steps:5});await p.mouse.up();assert.deepEqual(errors,[]);
 const mobile=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const m=await mobile.newPage();await m.goto(base+'/wall');await m.getByText('Ready',{exact:true}).waitFor();await m.touchscreen.tap(200,400);await m.getByText(/^[1-9]\d?s$/).waitFor();assert.equal(await m.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log('PASS independent sessions: placement, preview non-persistence, broadcast, cooldown, refresh, zoom, drag, mobile tap');
}finally{await browser.close()}
