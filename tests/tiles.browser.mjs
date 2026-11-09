import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.OPEN_WEB_TEST_URL;if(!base)throw Error('Set OPEN_WEB_TEST_URL to an isolated test instance');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {const context=await browser.newContext({viewport:{width:1000,height:700}});const p=await context.newPage();let active=0,peak=0,total=0;
 await p.route('**/api/wall/tile/**',async route=>{active++;total++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,35));const response=await route.fetch();await route.fulfill({response});}finally{active--;}});
 await p.goto(base+'/wall');await p.getByText('Ready',{exact:true}).waitFor();await p.mouse.move(500,350);await p.mouse.wheel(0,4000);
 await p.waitForTimeout(1200);assert.ok(total>30,`only ${total} requests tested`);assert.ok(peak<=6,`peak tile requests was ${peak}`);
 await p.unrouteAll({behavior:'wait'});console.log(`PASS zoomed-out tile loading: peak ${peak} concurrent requests (${total} started)`);
}finally{await browser.close();}
