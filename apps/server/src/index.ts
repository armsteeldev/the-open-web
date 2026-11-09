import { createApp } from './app.js';
import { readConfig } from './config.js';
const config=readConfig(process.env);
const app=await createApp(config);
await app.listen({host:'127.0.0.1',port:config.port});
let stopping=false;
async function shutdown(signal:string) {
 if(stopping)return; stopping=true;
 app.log.info({signal},'Shutting down');
 try {await app.close();} catch(error) {app.log.error(error,'Shutdown failed');process.exitCode=1;}
}
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
process.on('SIGINT',()=>void shutdown('SIGINT'));
