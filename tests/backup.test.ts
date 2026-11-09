import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../apps/server/src/app.js';
import { openDb, place } from '../apps/server/src/db.js';
test('online backup captures committed WAL, restores, and refuses overwrite',async()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-backup-'));const source=join(root,'live.sqlite'),destination=join(root,'backup.sqlite');const live=openDb(source);
 try {place(live,'visitor',3,4,5,1000,5000);
 const run=()=>spawnSync(process.execPath,['scripts/backup.mjs',source,destination],{encoding:'utf8'});
 const first=run();assert.equal(first.status,0,`${first.stdout}\n${first.stderr}`);assert.equal(statSync(destination).mode & 0o077,0);
 const restored=openDb(destination);assert.equal((restored.prepare('SELECT pixels FROM wall_tiles').get()!.pixels as Uint8Array)[403],5);restored.close();
 assert.notEqual(run().status,0);assert.equal(readdirSync(root).some(name=>name.startsWith('backup.sqlite.partial-')),false);const preserved=openDb(destination);assert.equal((preserved.prepare('SELECT pixels FROM wall_tiles').get()!.pixels as Uint8Array)[403],5);preserved.close();
 const restoredPath=join(root,'restored.sqlite');copyFileSync(destination,restoredPath);const origin='http://localhost:4321';const app=await createApp({dbPath:restoredPath,origin,cooldown:10000,writes:true,secure:false});try{await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;const base=`http://127.0.0.1:${port}`;const tile=await fetch(base+'/api/wall/tile/0/0');assert.equal(new Uint8Array(await tile.arrayBuffer())[403],5);const session=await fetch(base+'/api/session');const cookie=session.headers.get('set-cookie')!;const placed=await fetch(base+'/api/wall/pixel',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({x:8,y:9,color:6})});assert.equal(placed.status,200);const after=await fetch(base+'/api/wall/tile/0/0');assert.equal(new Uint8Array(await after.arrayBuffer())[908],6);}finally{await app.close();}
 }finally{live.close();rmSync(root,{recursive:true,force:true});}
});
