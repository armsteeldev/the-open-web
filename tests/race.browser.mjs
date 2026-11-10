import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL;if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
let release,timeout;
try {
 const a=await browser.newContext({viewport:{width:1000,height:700}}),b=await browser.newContext({viewport:{width:1000,height:700}}),writer=await a.newPage(),reader=await b.newPage();let fetches=0,ready,refetched;
 const snapshotReady=new Promise(r=>{ready=r;}),gate=new Promise(r=>{release=r;}),secondFetch=new Promise(r=>{refetched=r;});
 await Promise.all([reader.goto(base+'/wall'),writer.goto(base+'/wall')]);await Promise.all([reader.getByText('Ready',{exact:true}).waitFor(),writer.getByText('Ready',{exact:true}).waitFor()]);
 // Tile 11,10 is initially outside the viewport. Capture its old snapshot only after the WebSocket has connected.
 await reader.route('**/api/wall/tile/11/10',async route=>{fetches++;if(fetches===1){const snapshot=await route.fetch();await snapshot.body();ready();await gate;await route.fulfill({response:snapshot});}else{refetched();await route.continue();}});
 for(const p of [reader,writer]){await p.mouse.move(900,350);await p.mouse.down();await p.mouse.move(100,350,{steps:5});await p.mouse.up();}
 await snapshotReady;assert.equal(fetches,1);await writer.locator('[data-color="4"]').click();const response=writer.waitForResponse(r=>r.url().endsWith('/api/wall/pixel')&&r.request().method()==='POST');await writer.locator('canvas').click({position:{x:504,y:354}});assert.equal((await response).status(),200);
 try {await Promise.race([secondFetch,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('no resynchronization fetch')),5000);})]);}finally{clearTimeout(timeout);release();}
 await reader.waitForFunction(()=>{const d=document.querySelector('canvas').getContext('2d').getImageData(504,354,1,1).data;return d[0]===229&&d[1]===57&&d[2]===53;});assert.ok(fetches>=2);await reader.unrouteAll({behavior:'wait'});console.log('PASS stale in-flight snapshot cannot overwrite a realtime placement');
}finally{release?.();clearTimeout(timeout);await browser.close();}
