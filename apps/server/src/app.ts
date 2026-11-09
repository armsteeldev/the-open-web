import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { randomBytes, createHash } from 'node:crypto';
import { cleanupCooldowns, openDb, place, validTile } from './db.js';
import { validPixel, TILE } from '../../../packages/shared/wall.js';
import { spaces } from '../../../packages/shared/spaces.js';
import type { WebSocket } from 'ws';
import { NetworkBudget } from './services/network-budget.js';
import { SpaceChannels } from './realtime/channels.js';
import { writesBlocked } from './services/write-gate.js';
import { PLACEMENT_COOLDOWN_MS } from './config.js';
export async function createApp(opts: {dbPath:string, origin:string, cooldown:number, writes:boolean, secure:boolean, writeGatePath?:string}) {
 if(opts.cooldown!==PLACEMENT_COOLDOWN_MS) throw new Error(`cooldown is fixed at ${PLACEMENT_COOLDOWN_MS} ms`);
 const allowedOrigins = new Set([opts.origin]); if (!opts.secure && opts.origin === 'http://localhost:4321') allowedOrigins.add('http://127.0.0.1:4321');
 const db=openDb(opts.dbPath); const app=Fastify({logger:true, logController:new LogController({disableRequestLogging:true}), bodyLimit:1024, trustProxy:'127.0.0.1'});
 await app.register(cookie); await app.register(websocket,{options:{maxPayload:1024}});
 const networkBudget=new NetworkBudget(); const sockets=new SpaceChannels(); const availableSpaces=new Set<string>(spaces.map(space=>space.id)); const writeLimits=new Map<string,{n:number,until:number}>(); const counts=new Map<string,number>(); const limits=new Map<string,{n:number,until:number}>();
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const ip=req.ip; const now=Date.now(); let l=limits.get(ip); if(!l || l.until<now) {if(!l && limits.size>=10000)return reply.code(429).send({error:'rate limited'});l={n:0,until:now+60000}; limits.set(ip,l);} if(++l.n>600) return reply.code(429).send({error:'rate limited'});
  if (limits.size>10000) for(const [key,v] of limits) if(v.until<now) limits.delete(key);
  if ((req.method==='POST' || req.url==='/api/session')) { let w=writeLimits.get(ip); if(!w || w.until<now) {if(!w && writeLimits.size>=10000)return reply.code(429).send({error:'rate limited'});w={n:0,until:now+60000};writeLimits.set(ip,w);} if(++w.n>180) return reply.code(429).send({error:'rate limited'}); if(writeLimits.size>10000) for(const [key,v] of writeLimits) if(v.until<now) writeLimits.delete(key); }
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && !allowedOrigins.has(req.headers.origin ?? '')) return reply.code(403).send({error:'origin'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && (!opts.writes || writesBlocked(opts.writeGatePath))) return reply.code(503).send({error:'writes disabled'});
 });
 let healthCheckedAt=Number.NEGATIVE_INFINITY, integrityHealthy=false;
 app.get('/api/health',async(_req,reply)=>{
  try {if(!db.prepare('SELECT version FROM migrations ORDER BY version DESC LIMIT 1').get())throw new Error('missing migration');}
  catch {return reply.code(503).send({ok:false});}
  const now=performance.now();
  if(now-healthCheckedAt>=30000){
   healthCheckedAt=now;
   try {const check=db.prepare('PRAGMA quick_check(1)').get() as {quick_check:string}|undefined;integrityHealthy=check?.quick_check==='ok';}
   catch {integrityHealthy=false;}
  }
  return integrityHealthy?{ok:true}:reply.code(503).send({ok:false});
 });
 app.get('/api/session',async(req,reply)=>{
  let id=req.cookies.ow_id; if(!id || !/^[a-f0-9]{64}$/.test(id)) {id=randomBytes(32).toString('hex'); reply.setCookie('ow_id',id,{path:'/',httpOnly:true,secure:opts.secure,sameSite:'strict',maxAge:31536000});}
  const visitor=createHash('sha256').update(id).digest('hex'); const row=db.prepare('SELECT placed_at FROM visitor_cooldowns WHERE visitor=?').get(visitor) as {placed_at:number}|undefined;
  reply.header('Cache-Control','no-store'); return {retryAt:row ? row.placed_at+opts.cooldown : 0};
 });
 app.get('/api/wall/tile/:x/:y',async(req,reply)=>{const {x,y}=req.params as {x:string,y:string}; if(!/^(?:[0-9]|1[0-9])$/.test(x)||!/^(?:[0-9]|1[0-9])$/.test(y)) return reply.code(400).send(); const row=db.prepare('SELECT pixels FROM wall_tiles WHERE x=? AND y=?').get(Number(x),Number(y)) as {pixels:Uint8Array}|undefined; if(row && !validTile(row.pixels)) { req.log.error('Invalid wall tile data'); return reply.code(500).send({error:'tile unavailable'}); } return reply.header('Cache-Control','no-store').type('application/octet-stream').send(Buffer.from(row?.pixels ?? new Uint8Array(TILE*TILE)));});
 app.post('/api/wall/pixel',async(req,reply)=>{const id=req.cookies.ow_id; if(!id || !/^[a-f0-9]{64}$/.test(id)) return reply.code(401).send({error:'session required'}); const p=req.body as {x?:unknown,y?:unknown,color?:unknown}; if(!p || !validPixel(p.x,p.y,p.color)) return reply.code(400).send({error:'invalid pixel'});  const visitor=createHash('sha256').update(id).digest('hex'); const networkWait=networkBudget.take(req.ip,performance.now()); if(networkWait) return reply.code(429).send({ok:false,retryAt:Date.now()+networkWait}); let result; try { result=place(db,visitor,p.x,p.y as number,p.color as number,Date.now(),opts.cooldown); } catch(error) { networkBudget.refund(req.ip); throw error; } if(!result.ok) { networkBudget.refund(req.ip); return reply.code(429).send(result); } sockets.broadcast('wall',{v:1,space:'wall',type:'pixel',x:p.x,y:p.y,color:p.color}); return result;});
 app.get('/api/events',{websocket:true},(socket,req)=>{socket.on('error',()=>{});const {space} = req.query as {space?:unknown}; if(typeof space!=='string' || !availableSpaces.has(space) || !allowedOrigins.has(req.headers.origin ?? '') || sockets.size>=500 || (counts.get(req.ip)??0)>=10){socket.close(1008);return;} sockets.add(socket,space); (socket as WebSocket & {isAlive?:boolean}).isAlive=true; socket.on('pong',()=>{(socket as WebSocket & {isAlive?:boolean}).isAlive=true;}); counts.set(req.ip,(counts.get(req.ip)??0)+1); socket.on('message',()=>socket.close(1008)); socket.on('close',()=>{sockets.delete(socket); const n=(counts.get(req.ip)??1)-1; if(n) counts.set(req.ip,n); else counts.delete(req.ip);});});
 const heartbeat=setInterval(()=>{networkBudget.prune(performance.now());const now=Date.now();try{cleanupCooldowns(db,now,opts.cooldown);}catch(error){app.log.error(error,'Cooldown cleanup failed');}for(const [key,v] of limits) if(v.until<now)limits.delete(key);for(const [key,v] of writeLimits)if(v.until<now)writeLimits.delete(key);for(const s of sockets.sockets()) { const alive=s as WebSocket & {isAlive?:boolean}; if(alive.isAlive===false) {s.terminate();continue;} if(s.readyState!==1)continue; alive.isAlive=false; try{s.ping();}catch{s.terminate();} }},30000); heartbeat.unref();
 app.addHook('onClose',async()=>{clearInterval(heartbeat);for(const s of sockets.sockets()) s.terminate(); db.close();}); return app;
}
