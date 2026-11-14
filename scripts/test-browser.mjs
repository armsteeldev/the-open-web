import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function port() {const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(child) {if(!child || child.exitCode!==null || child.signalCode!==null)return;const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}
async function waitForOutput(child, expected) {await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>done(Error(`test process did not announce ${expected}: ${output.slice(-1000)}`)),15000);const done=err=>{clearTimeout(timeout);child.stdout.off('data',onData);child.stderr.off('data',onData);child.off('exit',onExit);if(err)reject(err);else resolve();};const onData=chunk=>{output+=chunk.toString();if(output.includes(expected))done();};const onExit=()=>done(Error(`test process exited before ${expected}: ${output.slice(-1000)}`));child.stdout.on('data',onData);child.stderr.on('data',onData);child.once('exit',onExit);});}
async function waitFor(url, child) {for(let i=0;i<150;i++){if(child.exitCode!==null || child.signalCode!==null)throw Error(`test server exited before readiness (${url})`);try {if((await fetch(url)).ok)return;}catch{/* server is still starting */}await new Promise(r=>setTimeout(r,100));}throw Error(`test server not ready: ${url}`);}
const temp=mkdtempSync(join(tmpdir(),'open-web-browser-'));const apiPort=await port(),webPort=await port();const base=`http://127.0.0.1:${webPort}`, api=`http://127.0.0.1:${apiPort}`;let web,server;
try {
 web=spawn(process.execPath,['node_modules/astro/bin/astro.mjs','dev','--root','apps/web','--host','127.0.0.1','--port',String(webPort),'--strictPort','--ignore-lock'],{env:{...process.env,WEB_API_TARGET:api},stdio:['ignore','pipe','pipe']});
 await waitForOutput(web,base);
 const allTests=['menu','keyboard','accessibility','touch','viewport','tiles','race','reliability','refinement','chat-recovery','chat','bottle'];
 const selected=process.env.ONLY_BROWSER_TEST?[process.env.ONLY_BROWSER_TEST]:allTests;
 if(selected.some(name=>!allTests.includes(name)))throw Error(`Unknown browser test selection: ${selected.join(',')}`);
 for(const name of selected) {
  server=spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{env:{...process.env,DB_PATH:join(temp,`${name}.sqlite`),PORT:String(apiPort),ORIGIN:base,COOKIE_SECURE:'false',WRITES_ENABLED:'true'},stdio:['ignore','pipe','pipe']});
  await waitForOutput(server,`Server listening at ${api}`);
  await waitFor(api+'/api/health',server);await waitFor(base+'/wall',web);
  const test=spawn(process.execPath,[`tests/${name}.browser.mjs`],{env:{...process.env,OPEN_WEB_TEST_URL:base,OPEN_WEB_TEST_API:api},stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{test.once('error',reject);test.once('exit',(code,signal)=>signal?reject(Error(`${name} terminated: ${signal}`)):resolve(code));});
  if(code!==0)throw Error(`${name} browser test failed (${code})`);
  await stop(server);server=undefined;
 }
} finally {await stop(server);await stop(web);rmSync(temp,{recursive:true,force:true});}
