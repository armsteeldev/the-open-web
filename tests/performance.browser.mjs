import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base=process.env.OPEN_WEB_TEST_URL;
if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated HTTPS Caddy instance');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return Number(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)].toFixed(2));};
const range=values=>({p50:percentile(values,.5),p95:percentile(values,.95),max:Number(Math.max(...values).toFixed(2))});
try {
 const context=await browser.newContext({viewport:{width:1280,height:800},ignoreHTTPSErrors:true});
 const page=await context.newPage();
 const tileStart=new Map(),tileTimes=[],tileUrls=[];
 page.on('request',request=>{if(request.url().includes('/api/wall/tile/')){tileStart.set(request,performance.now());tileUrls.push(request.url());}});
 page.on('requestfinished',request=>{if(tileStart.has(request)){tileTimes.push(performance.now()-tileStart.get(request));tileStart.delete(request);}});
 const navigationStart=performance.now();
 const response=await page.goto(`${base}/wall/`);
 assert.equal(response.status(),200);
 await page.getByText('Ready',{exact:true}).waitFor({timeout:15000});
 await page.waitForFunction(()=>document.querySelector('#wall')?.width>0);
 await page.waitForTimeout(500);
 const initialTileTimes=[...tileTimes],initialTileUrls=[...tileUrls];
 const pageMetrics=await page.evaluate(()=>{
  const nav=performance.getEntriesByType('navigation')[0];
  const paint=performance.getEntriesByType('paint');
  const resources=performance.getEntriesByType('resource');
  return {
   domContentLoadedMs:Number(nav.domContentLoadedEventEnd.toFixed(2)),
   loadEventMs:Number(nav.loadEventEnd.toFixed(2)),
   firstContentfulPaintMs:Number((paint.find(x=>x.name==='first-contentful-paint')?.startTime??0).toFixed(2)),
   resourceCount:resources.length,
   transferredBytes:resources.reduce((sum,r)=>sum+r.transferSize,0),
   canvasBackingPixels:document.querySelector('#wall').width*document.querySelector('#wall').height,
   jsHeapMiB:performance.memory?Number((performance.memory.usedJSHeapSize/1048576).toFixed(1)):null,
  };
 });

 const zoomFrames=[];
 for(let i=0;i<20;i++){
  await page.evaluate(()=>{window.__frameDelay=null;document.querySelector('#wall').addEventListener('wheel',()=>{const t=performance.now();requestAnimationFrame(()=>window.__frameDelay=performance.now()-t);},{once:true});});
  await page.mouse.wheel(0,i%2?-25:25);
  await page.waitForFunction(()=>window.__frameDelay!==null);
  zoomFrames.push(await page.evaluate(()=>window.__frameDelay));
 }
 const panFrames=[];
 for(let i=0;i<20;i++){
  const x=500+i;
  await page.mouse.move(x,400);await page.mouse.down();
  await page.evaluate(()=>{window.__frameDelay=null;document.querySelector('#wall').addEventListener('pointermove',event=>{if(event.buttons){const t=performance.now();requestAnimationFrame(()=>window.__frameDelay=performance.now()-t);}},{once:true});});
  await page.mouse.move(x+10,410);await page.waitForFunction(()=>window.__frameDelay!==null);panFrames.push(await page.evaluate(()=>window.__frameDelay));await page.mouse.up();
 }
 assert.ok(initialTileTimes.length>0,'no initial tile requests were observed');
 assert.equal(new Set(initialTileUrls).size,initialTileUrls.length,`duplicate initial tile fetches: ${initialTileUrls.join(', ')}`);
 console.log(JSON.stringify({browser:'Chromium desktop emulation 1280x800',page:{...pageMetrics,initialTileRequests:initialTileTimes.length,initialTiles:initialTileUrls.map(url=>url.split('/').slice(-2).join(',')),tileRequestMs:range(initialTileTimes)},zoomToNextFrameMs:range(zoomFrames),panToNextFrameMs:range(panFrames),elapsedSinceNavigationStartMs:Number((performance.now()-navigationStart).toFixed(2))}));
 await context.close();
} finally {await browser.close();}
