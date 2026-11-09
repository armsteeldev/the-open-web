import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL; if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance; browser tests can modify its database');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
 const context=await browser.newContext({viewport:{width:1000,height:700}});const page=await context.newPage();let tileRequests=0,placements=0;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/wall/pixel'))placements++;});
 await page.route('**/api/wall/tile/10/10',async route=>{tileRequests++;if(tileRequests===1)await route.fulfill({status:503,body:'unavailable'});else await route.continue();});
 await page.goto(base+'/wall');await page.getByText('Ready',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('canvas')!==null);await page.waitForTimeout(4000);
 assert.ok(tileRequests>=2 && tileRequests<=3,`tile fetch count ${tileRequests}`);
 await page.mouse.click(504,354,{button:'right'});await page.waitForTimeout(250);assert.equal(placements,0);assert.deepEqual(errors,[]);
 const reconnectContext=await browser.newContext({viewport:{width:1000,height:700}});const reconnectPage=await reconnectContext.newPage();let attempts=0;
 await reconnectPage.routeWebSocket('**/api/events?space=wall',socket=>{attempts++;if(attempts===1)socket.close();else socket.connectToServer();});
 await reconnectPage.goto(base+'/wall');
 await reconnectPage.waitForFunction(()=>document.querySelector('#status')?.textContent==='Reconnecting…');
 const placed=await page.evaluate(async()=>{const r=await fetch('/api/wall/pixel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:1000,y:1000,color:4})});return r.status;});assert.equal(placed,200);
 await reconnectPage.getByText('Ready',{exact:true}).waitFor({timeout:10000});assert.ok(attempts>=2);
 await reconnectPage.waitForFunction(()=>{const d=document.querySelector('canvas').getContext('2d').getImageData(504,354,1,1).data;return d[0]===229&&d[1]===57&&d[2]===53;});
 console.log(`PASS tile recovery (${tileRequests} requests), secondary click, reconnect and state resynchronization`);
}finally{await browser.close();}
