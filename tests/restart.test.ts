import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
async function ready(base:string,child:ChildProcess){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('server exited');try{if((await fetch(base+'/api/health')).ok)return;}catch{/* server is still starting */} await new Promise(r=>setTimeout(r,50));}throw Error('server not ready');}
test('SIGTERM closes live connections and preserves committed pixels across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-restart-'));const port=await freePort(),base=`http://127.0.0.1:${port}`,origin='http://localhost:4321';let child:ChildProcess|undefined;
 const start=()=>spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{env:{...process.env,DB_PATH:join(dir,'db'),PORT:String(port),ORIGIN:origin},stdio:'ignore'});
 try {child=start();await ready(base,child);const ws=new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`,{origin});await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject);});
 const session=await fetch(base+'/api/session');const cookie=session.headers.get('set-cookie')!;const res=await fetch(base+'/api/wall/pixel',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({x:1,y:2,color:4})});assert.equal(res.status,200);
 const ended=new Promise<number|null>(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');let timeout:NodeJS.Timeout|undefined;const result=await Promise.race([ended,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('shutdown timeout')),5000);})]).finally(()=>clearTimeout(timeout));assert.equal(result,0);
 child=start();await ready(base,child);const tile=new Uint8Array(await (await fetch(base+'/api/wall/tile/0/0')).arrayBuffer());assert.equal(tile[201],4);
 }finally{if(child && child.exitCode===null){const ended=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');await ended;}rmSync(dir,{recursive:true,force:true});}
});
test('a hard process crash preserves committed WAL pixels across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-crash-'));const port=await freePort(),base=`http://127.0.0.1:${port}`,origin='http://localhost:4321';let child:ChildProcess|undefined;
 const start=()=>spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{env:{...process.env,DB_PATH:join(dir,'db'),PORT:String(port),ORIGIN:origin},stdio:'ignore'});
 try {child=start();await ready(base,child);const session=await fetch(base+'/api/session');const cookie=session.headers.get('set-cookie')!;const res=await fetch(base+'/api/wall/pixel',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({x:21,y:34,color:7})});assert.equal(res.status,200);
  const ended=new Promise<{signal:NodeJS.Signals|null}>(resolve=>child!.once('exit',(_code,signal)=>resolve({signal})));child.kill('SIGKILL');assert.equal((await ended).signal,'SIGKILL');child=start();await ready(base,child);const tile=new Uint8Array(await (await fetch(base+'/api/wall/tile/0/0')).arrayBuffer());assert.equal(tile[3421],7);
 } finally {if(child && child.exitCode===null && child.signalCode===null){const ended=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');await ended;}rmSync(dir,{recursive:true,force:true});}
});
test('normal requests do not log cookie or request URL',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'open-web-privacy-'));const port=await freePort(),base=`http://127.0.0.1:${port}`,origin='http://localhost:4321';const secret='ab'.repeat(32);let logs='';
 const child=spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{env:{...process.env,DB_PATH:join(dir,'db'),PORT:String(port),ORIGIN:origin},stdio:['ignore','pipe','pipe']});child.stdout?.on('data',c=>{logs+=c.toString();});child.stderr?.on('data',c=>{logs+=c.toString();});
 try {await ready(base,child);const res=await fetch(base+'/api/session?request-canary',{headers:{cookie:`ow_id=${secret}`}});assert.equal(res.status,200);const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;assert.ok(!logs.includes(secret));assert.ok(!logs.includes('request-canary'));}
 finally {if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}rmSync(dir,{recursive:true,force:true});}
});
