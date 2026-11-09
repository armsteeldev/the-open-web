import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL;if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});const p=await context.newPage();await p.goto(base+'/wall');await p.getByText('Ready',{exact:true}).waitFor();let writes=0;p.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/wall/pixel'))writes++;});
 await p.mouse.move(275,422);const before=await p.locator('#coords').innerText();const cdp=await context.newCDPSession(p);const point=(x,y,id)=>({x,y,id,radiusX:1,radiusY:1,force:1});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(155,422,0)]});await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(155,422,0),point(235,422,1)]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(115,422,0),point(275,422,1)]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.mouse.move(275,422);const after=await p.locator('#coords').innerText();
 assert.equal(writes,0);assert.equal(before,'1010, 1000');assert.equal(after,'1005, 1000');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(200,200,2)]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await p.waitForTimeout(100);assert.equal(writes,0);
 console.log('PASS pinch zoom changes scale around midpoint without placing a pixel');
} finally {await browser.close();}
