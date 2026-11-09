import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'open-web-release-'));let server;
try {
 cpSync('dist',join(root,'dist'),{recursive:true});cpSync('package.json',join(root,'package.json'));cpSync('package-lock.json',join(root,'package-lock.json'));
 const install=spawnSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,encoding:'utf8'});if(install.status!==0)throw Error(`production install failed: ${install.stderr}`);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['dist/apps/server/src/index.js'],{cwd:root,env:{...process.env,DB_PATH:join(root,'test.sqlite'),PORT:String(port),ORIGIN:base,COOKIE_SECURE:'false',WRITES_ENABLED:'true'},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>end(Error(`server startup timed out: ${text}`)),10000);function end(e){clearTimeout(timer);server.stdout.off('data',data);server.stderr.off('data',data);server.off('exit',exit);if(e)reject(e);else resolve();}function data(c){text+=c.toString();if(text.includes(`Server listening at ${base}`))end();}function exit(){end(Error(`server exited: ${text}`));}server.stdout.on('data',data);server.stderr.on('data',data);server.once('exit',exit);});
 const session=await fetch(base+'/api/session');if(!session.ok)throw Error('session failed');const placed=await fetch(base+'/api/wall/pixel',{method:'POST',headers:{cookie:session.headers.get('set-cookie'),origin:base,'content-type':'application/json'},body:JSON.stringify({x:1,y:2,color:4})});if(placed.status!==200)throw Error(`placement failed ${placed.status}`);
 const tile=new Uint8Array(await (await fetch(base+'/api/wall/tile/0/0')).arrayBuffer());if(tile[201]!==4)throw Error('pixel not persisted');console.log('PASS compiled server with production-only dependencies and copied migrations');
} finally {if(server && server.exitCode===null && server.signalCode===null){const ended=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await ended;}rmSync(root,{recursive:true,force:true});}
