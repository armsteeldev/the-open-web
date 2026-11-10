import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { WebSocket } from 'ws';
const origin='http://localhost:4321';
test('identity, validation, cooldown, overwrite, broadcast and restart persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-'));const path=join(dir,'db');let app=await createApp({dbPath:path,origin,cooldown:10000,writes:true,secure:false});
 try {await app.listen({port:0,host:'127.0.0.1'});const port=(app.server.address() as {port:number}).port;
 const session=await app.inject({url:'/api/session'});const cookie=session.headers['set-cookie'] as string;assert.match(cookie,/HttpOnly/);assert.equal(session.json().retryAfterMs,0);const cookie2=(await app.inject({url:'/api/session'})).headers['set-cookie'] as string;
 const ws=new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`,{origin});await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject);});const event=new Promise<string>(resolve=>ws.once('message',data=>resolve(data.toString())));
 const post=(c:string,body:Record<string,number>)=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie:c,origin},payload:body});
 assert.equal((await post(cookie,{x:-1,y:0,color:0})).statusCode,400);assert.equal((await post(cookie,{x:0,y:0,color:16})).statusCode,400);
 const placed=await post(cookie,{x:3,y:4,color:2});assert.equal(placed.statusCode,200);assert.ok(placed.json().retryAfterMs>0&&placed.json().retryAfterMs<=10000);assert.equal(JSON.parse(await event).color,2);
 const denied=await post(cookie,{x:3,y:4,color:3});assert.equal(denied.statusCode,429);assert.ok(denied.json().retryAfterMs>0&&denied.json().retryAfterMs<=10000);assert.equal((await post(cookie2,{x:3,y:4,color:3})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin:'https://evil.example'},payload:{x:1,y:1,color:1}})).statusCode,403);
 ws.terminate();await app.close();app=await createApp({dbPath:path,origin,cooldown:10000,writes:true,secure:false});const tile=await app.inject({url:'/api/wall/tile/0/0'});assert.equal(tile.rawPayload[403],3);assert.equal((await post(cookie,{x:5,y:4,color:1})).statusCode,429);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('simultaneous requests for one identity admit one placement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-race-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {const cookie=(await app.inject({url:'/api/session'})).headers['set-cookie'] as string;
 const responses=await Promise.all(Array.from({length:8},(_,i)=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin},payload:{x:i,y:0,color:1}})));
 assert.equal(responses.filter(r=>r.statusCode===200).length,1);assert.equal(responses.filter(r=>r.statusCode===429).length,7);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent visitors overwriting one pixel keep the final database value aligned with broadcast order',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-conflict-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;const cookies=[];for(let i=0;i<2;i++)cookies.push((await app.inject({url:'/api/session'})).headers['set-cookie'] as string);
  const ws=new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`,{origin});await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});const events:number[]=[];ws.on('message',data=>events.push(JSON.parse(data.toString()).color));
  const results=await Promise.all(cookies.map((cookie,i)=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin},payload:{x:8,y:9,color:i+4}})));
  assert.deepEqual(results.map(result=>result.statusCode),[200,200]);for(let i=0;i<50&&events.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(events.length,2);
  const tile=await app.inject({url:'/api/wall/tile/0/0'});assert.equal(tile.rawPayload[908],events[1]);ws.terminate();
 } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('local development accepts the advertised loopback origin but rejects unrelated origins',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-origin-'));const app=await createApp({dbPath:join(dir,'db'),origin:'http://localhost:4321',cooldown:10000,writes:true,secure:false});
 try {const cookie=(await app.inject({url:'/api/session'})).headers['set-cookie'] as string;const request=(origin:string)=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin},payload:{x:1999,y:1999,color:15}});assert.equal((await request('http://127.0.0.1:4321')).statusCode,200);assert.equal((await request('http://evil.example')).statusCode,403);} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('corrupted tile reads fail without replacing stored data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-corrupt-'));const path=join(dir,'db');const app=await createApp({dbPath:path,origin,cooldown:10000,writes:true,secure:false});
 try {const {DatabaseSync}=await import('node:sqlite');const raw=new DatabaseSync(path);raw.prepare('INSERT INTO wall_tiles VALUES (0,0,?)').run(new Uint8Array([1]));raw.close();const response=await app.inject({url:'/api/wall/tile/0/0'});assert.equal(response.statusCode,500);assert.deepEqual(response.json(),{error:'tile unavailable'});}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('fresh cookies share a bounded network write budget without charging rejected writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-abuse-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {const cookies=[];for(let i=0;i<14;i++)cookies.push((await app.inject({url:'/api/session'})).headers['set-cookie'] as string);
 const post=(cookie:string,x:number)=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin},payload:{x,y:3,color:1}});
 for(let i=0;i<12;i++)assert.equal((await post(cookies[i],i)).statusCode,200);
 const denied=await post(cookies[12],12);assert.equal(denied.statusCode,429);assert.ok(denied.json().retryAt>Date.now());
 assert.equal((await post(cookies[0],13)).statusCode,429);
 const tile=await app.inject({url:'/api/wall/tile/0/0'});for(let x=0;x<12;x++)assert.equal(tile.rawPayload[300+x],1);assert.equal(tile.rawPayload[312],0);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('broad per-network request cap leaves room for the placement token bucket',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-network-cap-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {for(let i=0;i<180;i++)assert.equal((await app.inject({url:'/api/session'})).statusCode,200);assert.equal((await app.inject({url:'/api/session'})).statusCode,429);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('websocket rejects missing or unregistered subscriptions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-subscriptions-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {await app.listen({port:0,host:'127.0.0.1'});const port=(app.server.address() as {port:number}).port;
 for(const query of ['', '?space=unimplemented', '?space=wall&space=wall']) {const ws=new WebSocket(`ws://127.0.0.1:${port}/api/events${query}`,{origin});const code=await new Promise<number>((resolve,reject)=>{ws.once('close',resolve);ws.once('error',reject);});assert.equal(code,1008);}
 const valid=new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`,{origin});await new Promise<void>((resolve,reject)=>{valid.once('open',()=>resolve());valid.once('error',reject);});valid.terminate();assert.equal((await app.inject({url:'/api/health'})).statusCode,200);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('trusted proxy distinguishes network budgets and an untrusted peer cannot spoof forwarded addresses',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-proxy-'));const app=await createApp({dbPath:join(dir,'db'),origin,cooldown:10000,writes:true,secure:false});
 try {const cookies=[];for(let i=0;i<27;i++)cookies.push((await app.inject({url:'/api/session'})).headers['set-cookie'] as string);
 const post=(cookie:string,x:number,remoteAddress:string,forwarded:string)=>app.inject({method:'POST',url:'/api/wall/pixel',remoteAddress,headers:{cookie,origin,'x-forwarded-for':forwarded},payload:{x,y:5,color:1}});
 for(let i=0;i<12;i++)assert.equal((await post(cookies[i],i,'127.0.0.1','198.51.100.1')).statusCode,200);
 assert.equal((await post(cookies[12],12,'127.0.0.1','198.51.100.1')).statusCode,429);
 assert.equal((await post(cookies[13],13,'127.0.0.1','198.51.100.2')).statusCode,200);
 for(let i=14;i<26;i++)assert.equal((await post(cookies[i],i,'203.0.113.1',`198.51.100.${i+1}`)).statusCode,200);
 assert.equal((await post(cookies[26],26,'203.0.113.1','198.51.100.99')).statusCode,429);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('health fails when database metadata cannot be read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-health-'));const path=join(dir,'db');const app=await createApp({dbPath:path,origin,cooldown:10000,writes:true,secure:false});
 try {assert.equal((await app.inject({url:'/api/health'})).statusCode,200);const {DatabaseSync}=await import('node:sqlite');const raw=new DatabaseSync(path);raw.exec('DROP TABLE migrations');raw.close();assert.equal((await app.inject({url:'/api/health'})).statusCode,503);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
