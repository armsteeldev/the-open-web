import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import {WebSocket} from 'ws';
test('write gate immediately disables writes and fails closed if its directory is unavailable',async()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-gate-')),dir=join(root,'gate'),flag=join(dir,'disable');const {mkdirSync}=await import('node:fs');mkdirSync(dir);
 const origin='http://localhost:4321',app=await createApp({dbPath:join(root,'db'),origin,cooldown:10000,writes:true,secure:false,writeGatePath:flag});
 try {const cookie=(await app.inject({url:'/api/session'})).headers['set-cookie'] as string;const post=()=>app.inject({method:'POST',url:'/api/wall/pixel',headers:{cookie,origin},payload:{x:0,y:0,color:1}});
 writeFileSync(flag,'');assert.equal((await post()).statusCode,503);assert.equal((await app.inject({method:'POST',url:'/api/future',headers:{origin},payload:{}})).statusCode,503);await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;const ws=new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`,{origin});await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});const closed=new Promise<number>(resolve=>ws.once('close',resolve));ws.send(JSON.stringify({v:1,space:'wall',type:'pixel',x:0,y:0,color:1}));assert.equal(await closed,1008);assert.equal((await app.inject({url:'/api/wall/tile/0/0'})).rawPayload[0],0);unlinkSync(flag);rmSync(dir,{recursive:true});assert.equal((await post()).statusCode,503);mkdirSync(dir);assert.equal((await post()).statusCode,200);
 } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});
