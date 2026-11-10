import { SIZE, TILE, PALETTE } from '../../../../../packages/shared/wall.js';
const VIEWPORT_KEY='open-web-wall-viewport-v1';
function readViewport(){try{const value=JSON.parse(localStorage.getItem(VIEWPORT_KEY) ?? 'null');if(value && Number.isFinite(value.scale) && value.scale>=.15 && value.scale<=32 && Number.isFinite(value.x) && Number.isFinite(value.y))return value as {scale:number,x:number,y:number};}catch{}return null;}
const savedViewport=readViewport();
const canvas=document.querySelector<HTMLCanvasElement>('#wall')!; const ctx=canvas.getContext('2d')!;
const status=document.querySelector<HTMLElement>('#status')!, coords=document.querySelector<HTMLElement>('#coords')!;
let scale=savedViewport?.scale ?? 8, ox=0, oy=0, selected=3, retryDeadline=0, online=false, generation=0, placing=false;
const tiles=new Map<string,{canvas:HTMLCanvasElement,pixels:Uint8Array}>(), pending=new Map<string,Promise<void>>();
let width=0,height=0; let retryTimer:ReturnType<typeof setTimeout>|undefined; let viewportSaveTimer:ReturnType<typeof setTimeout>|undefined; const retryAfter=new Map<string,number>(); let reconnectDelay=1000; const pointers=new Map<number,{x:number,y:number}>(); let moved=false, lastDistance=0, startX=0, startY=0; let hover:{x:number,y:number}|null=null; let errorUntil=0; let keyboardCursor:{x:number,y:number}|null=null; let hoverScreen:{x:number,y:number}|null=null;
function saveViewport(){try{localStorage.setItem(VIEWPORT_KEY,JSON.stringify({scale,x:(width/2-ox)/scale,y:(height/2-oy)/scale}));}catch{}}
function scheduleViewportSave(){if(viewportSaveTimer)clearTimeout(viewportSaveTimer);viewportSaveTimer=setTimeout(()=>{viewportSaveTimer=undefined;saveViewport();},150);}
window.addEventListener('pagehide',()=>{if(viewportSaveTimer)clearTimeout(viewportSaveTimer);viewportSaveTimer=undefined;saveViewport();});
function resize(){const oldWidth=width,oldHeight=height;const centerX=oldWidth?(oldWidth/2-ox)/scale:0,centerY=oldHeight?(oldHeight/2-oy)/scale:0;width=canvas.clientWidth||innerWidth;height=canvas.clientHeight||innerHeight;if(oldWidth && oldHeight){ox=width/2-centerX*scale;oy=height/2-centerY*scale;bounds();}const dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);requestDraw();}
function bounds(){ox=Math.min(width-40,Math.max(40-SIZE*scale,ox));oy=Math.min(height-40,Math.max(40-SIZE*scale,oy));}
function zoom(factor:number,x:number,y:number){const n=Math.max(.15,Math.min(32,scale*factor));ox=x-(x-ox)*n/scale;oy=y-(y-oy)*n/scale;scale=n;bounds();scheduleViewportSave();requestDraw();}
function paintTile(t:{canvas:HTMLCanvasElement,pixels:Uint8Array}){const c=t.canvas.getContext('2d')!; const image=c.createImageData(TILE,TILE); for(let i=0;i<t.pixels.length;i++){const rgb=paletteRGB[t.pixels[i]] ?? paletteRGB[0];image.data[i*4]=rgb[0];image.data[i*4+1]=rgb[1];image.data[i*4+2]=rgb[2];image.data[i*4+3]=255;} c.putImageData(image,0,0);}
function scheduleTileRetry(){if(retryTimer || !retryAfter.size)return;const next=Math.min(...retryAfter.values());retryTimer=setTimeout(()=>{retryTimer=undefined;const now=Date.now();for(const [key,until] of retryAfter)if(until<=now)retryAfter.delete(key);requestDraw();scheduleTileRetry();},Math.max(0,next-Date.now()));}
const queued=new Map<string,{x:number,y:number,generation:number}>();let activeLoads=0;const MAX_TILE_LOADS=6;
function tileVisible(x:number,y:number){return ox+(x+1)*TILE*scale>0 && oy+(y+1)*TILE*scale>0 && ox+x*TILE*scale<width && oy+y*TILE*scale<height;}
function loadTile(x:number,y:number){
 const key=`${x},${y}`;if(tiles.has(key)||pending.has(key)||queued.has(key)||(retryAfter.get(key) ?? 0)>Date.now())return;
 queued.set(key,{x,y,generation});pumpTiles();
}
function pumpTiles(){
 while(activeLoads<MAX_TILE_LOADS && queued.size){
  const [key,job]=queued.entries().next().value!;queued.delete(key);
  if(job.generation!==generation||!tileVisible(job.x,job.y))continue;
  const g=job.generation;activeLoads++;
  const promise=(async()=>{try{
   const response=await fetch(`/api/wall/tile/${job.x}/${job.y}`,{cache:'no-store'});if(!response.ok)throw Error();
   const pixels=new Uint8Array(await response.arrayBuffer());if(pixels.length!==TILE*TILE)throw Error('Invalid tile');if(g!==generation)return;
   const tile={canvas:document.createElement('canvas'),pixels};tile.canvas.width=TILE;tile.canvas.height=TILE;paintTile(tile);tiles.set(key,tile);requestDraw();
  }catch{if(g===generation){retryAfter.set(key,Date.now()+3000);scheduleTileRetry();}}
  finally{if(g===generation)pending.delete(key);activeLoads--;pumpTiles();}})();
  pending.set(key,promise);
 }
}

let framePending=false;
function requestDraw(){if(framePending)return;framePending=true;requestAnimationFrame(()=>{framePending=false;draw();});}
const paletteRGB=PALETTE.map(color=>[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)]);
function draw(){if(hoverScreen)hover=coordinate(hoverScreen.x,hoverScreen.y);ctx.clearRect(0,0,width,height);ctx.fillStyle='#d7d7d7';ctx.fillRect(0,0,width,height);ctx.fillStyle='#fff';ctx.fillRect(ox,oy,SIZE*scale,SIZE*scale);ctx.imageSmoothingEnabled=false;const minX=Math.max(0,Math.floor(-ox/scale/TILE)),maxX=Math.min(19,Math.floor((width-ox)/scale/TILE));const minY=Math.max(0,Math.floor(-oy/scale/TILE)),maxY=Math.min(19,Math.floor((height-oy)/scale/TILE));for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const tile=tiles.get(`${x},${y}`);if(tile)ctx.drawImage(tile.canvas,ox+x*TILE*scale,oy+y*TILE*scale,TILE*scale,TILE*scale);else if(online)void loadTile(x,y);}
 if(scale>=5){const alpha=Math.min(.35,(scale-5)/25);ctx.strokeStyle=`rgba(30,30,30,${alpha})`;ctx.lineWidth=1/(devicePixelRatio||1);ctx.beginPath();const d=devicePixelRatio||1;for(let x=Math.max(0,Math.ceil(-ox/scale));x<=Math.min(SIZE,Math.floor((width-ox)/scale));x++){const px=(Math.round((ox+x*scale)*d)+.5)/d;ctx.moveTo(px,Math.max(0,oy));ctx.lineTo(px,Math.min(height,oy+SIZE*scale));}for(let y=Math.max(0,Math.ceil(-oy/scale));y<=Math.min(SIZE,Math.floor((height-oy)/scale));y++){const py=(Math.round((oy+y*scale)*d)+.5)/d;ctx.moveTo(Math.max(0,ox),py);ctx.lineTo(Math.min(width,ox+SIZE*scale),py);}ctx.stroke();}
 if(hover && hover.x>=0 && hover.y>=0 && hover.x<SIZE && hover.y<SIZE){const x=ox+hover.x*scale,y=oy+hover.y*scale;ctx.globalAlpha=.55;ctx.fillStyle=PALETTE[selected];ctx.fillRect(x,y,scale,scale);ctx.globalAlpha=1;if(scale>=4){ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,Math.max(0,scale-1),Math.max(0,scale-1));}} }
function invalidate(){generation++;tiles.clear();pending.clear();queued.clear();retryAfter.clear();if(retryTimer)clearTimeout(retryTimer);retryTimer=undefined;requestDraw();}
function connect(){const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/events?space=wall`);ws.onopen=()=>{online=true;reconnectDelay=1000;invalidate();};ws.onmessage=e=>{try{const p=JSON.parse(e.data);if(p.v!==1||p.space!=='wall'||p.type!=='pixel')return;const tx=Math.floor(p.x/TILE),ty=Math.floor(p.y/TILE),key=`${tx},${ty}`;const t=tiles.get(key);if(t){t.pixels[(p.y%TILE)*TILE+p.x%TILE]=p.color;const c=t.canvas.getContext('2d')!;c.fillStyle=PALETTE[p.color];c.fillRect(p.x%TILE,p.y%TILE,1,1);requestDraw();}else if(pending.has(key)){// Re-fetch to avoid applying a snapshot older than an event.
 invalidate();}}catch{}};ws.onclose=()=>{online=false;const delay=reconnectDelay*(.8+Math.random()*.4);reconnectDelay=Math.min(30000,reconnectDelay*2);setTimeout(connect,delay);};ws.onerror=()=>ws.close();}
function coordinate(x:number,y:number){return {x:Math.floor((x-ox)/scale),y:Math.floor((y-oy)/scale)};}
async function put(x:number,y:number){return putPixel(coordinate(x,y));}
async function putPixel(p:{x:number,y:number}){if(!online||placing||performance.now()<retryDeadline||p.x<0||p.y<0||p.x>=SIZE||p.y>=SIZE)return;placing=true;try{const r=await fetch('/api/wall/pixel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...p,color:selected})});const data=await r.json();if(Number.isFinite(data.retryAfterMs))retryDeadline=performance.now()+Math.max(0,data.retryAfterMs);if(!r.ok && !(r.status===429 && Number.isFinite(data.retryAfterMs))){errorUntil=Date.now()+4000;status.textContent='Could not place';}}catch{errorUntil=Date.now()+4000;status.textContent='Could not place';}finally{placing=false;}}
canvas.addEventListener('keydown',e=>{
 if(e.altKey || e.ctrlKey || e.metaKey)return;
 const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
 if(!delta[e.key] && e.key!=='Enter' && e.key!==' ')return;
 e.preventDefault();
 if(!keyboardCursor){const p=coordinate(width/2,height/2);keyboardCursor={x:Math.max(0,Math.min(SIZE-1,p.x)),y:Math.max(0,Math.min(SIZE-1,p.y))};}
 if(delta[e.key]){const step=e.shiftKey?10:1;keyboardCursor.x=Math.max(0,Math.min(SIZE-1,keyboardCursor.x+delta[e.key][0]*step));keyboardCursor.y=Math.max(0,Math.min(SIZE-1,keyboardCursor.y+delta[e.key][1]*step));}
 hoverScreen=null;hover={...keyboardCursor};
 const x=ox+(keyboardCursor.x+.5)*scale,y=oy+(keyboardCursor.y+.5)*scale;
 if(x<40 || x>width-40 || y<40 || y>height-40){ox=width/2-(keyboardCursor.x+.5)*scale;oy=height/2-(keyboardCursor.y+.5)*scale;bounds();scheduleViewportSave();}
 coords.textContent=`${keyboardCursor.x}, ${keyboardCursor.y}`;document.querySelector<HTMLElement>('#keyboard-position')!.textContent=`Pixel ${keyboardCursor.x}, ${keyboardCursor.y}`;requestDraw();
 if(e.key==='Enter'||e.key===' ')void putPixel(keyboardCursor);
});
canvas.addEventListener('blur',()=>{if(keyboardCursor){keyboardCursor=null;hover=null;requestDraw();}});
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(Math.exp(-e.deltaY*.0015),e.clientX,e.clientY);},{passive:false});
canvas.addEventListener('pointerdown',e=>{keyboardCursor=null;if(e.pointerType==='mouse' && e.button!==0)return;canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===1){moved=false;startX=e.clientX;startY=e.clientY;if(e.pointerType==='touch'){hover=coordinate(e.clientX,e.clientY);requestDraw();}}else {moved=true;const a=[...pointers.values()];lastDistance=Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);}});
canvas.addEventListener('pointermove',e=>{const p=coordinate(e.clientX,e.clientY);coords.textContent=p.x>=0&&p.y>=0&&p.x<SIZE&&p.y<SIZE?`${p.x}, ${p.y}`:'—, —';if(e.pointerType!=='touch' && !pointers.size){keyboardCursor=null;hoverScreen={x:e.clientX,y:e.clientY};hover=p;requestDraw();}const old=pointers.get(e.pointerId);if(!old)return;const dx=e.clientX-old.x,dy=e.clientY-old.y;if(Math.hypot(e.clientX-startX,e.clientY-startY)>5)moved=true;if(pointers.size===1){if(!moved)return;hoverScreen=null;hover=null;ox+=dx;oy+=dy;bounds();scheduleViewportSave();requestDraw();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});}else{const before=[...pointers.values()];const oldMid={x:(before[0].x+before[1].x)/2,y:(before[0].y+before[1].y)/2};pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const a=[...pointers.values()];const mid={x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2};ox+=mid.x-oldMid.x;oy+=mid.y-oldMid.y;scheduleViewportSave();const d=Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);if(lastDistance)zoom(d/lastDistance,mid.x,mid.y);lastDistance=d;}});
canvas.addEventListener('pointerup',e=>{if(!pointers.has(e.pointerId))return;if(pointers.size===1&&!moved)void put(e.clientX,e.clientY);pointers.delete(e.pointerId);if(e.pointerType==='touch'){hover=null;requestDraw();}});canvas.addEventListener('pointerleave',()=>{if(!pointers.size){hoverScreen=null;hover=null;requestDraw();}});canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);moved=true;hover=null;hoverScreen=null;requestDraw();});
document.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b=>b.addEventListener('click',()=>{selected=Number(b.dataset.color);requestDraw();document.querySelectorAll('.swatch').forEach(s=>s.setAttribute('aria-pressed',String(s===b)));}));
document.querySelector('#plus')!.addEventListener('click',()=>zoom(1.5,width/2,height/2));document.querySelector('#minus')!.addEventListener('click',()=>zoom(1/1.5,width/2,height/2));
let lastStatus='';
setInterval(()=>{
 const phase=Date.now()<errorUntil?'error':!online?'offline':performance.now()<retryDeadline?'cooldown':'ready';
 const label=phase==='error'?'Could not place':phase==='offline'?'Reconnecting…':phase==='cooldown'?`Next pixel in ${Math.ceil((retryDeadline-performance.now())/1000)}s`:'Ready';
 if(status.textContent!==label)status.textContent=label;
 if(phase!==lastStatus){lastStatus=phase;document.querySelector<HTMLElement>('#status-announcement')!.textContent=phase==='error'?'Could not place':phase==='offline'?'Reconnecting':phase==='cooldown'?'Please wait before placing another pixel':'Ready to place';}
},250);
window.addEventListener('resize',()=>{resize();scheduleViewportSave();});const initialWidth=canvas.clientWidth||innerWidth,initialHeight=canvas.clientHeight||innerHeight;if(savedViewport){ox=initialWidth/2-savedViewport.x*scale;oy=initialHeight/2-savedViewport.y*scale;}else{ox=initialWidth/2-SIZE*scale/2;oy=initialHeight/2-SIZE*scale/2;}resize();bounds();const center=coordinate(width/2,height/2);coords.textContent=`${center.x}, ${center.y}`;async function start(){try{const r=await fetch('/api/session');if(!r.ok)throw Error();const d=await r.json();if(Number.isFinite(d.retryAfterMs))retryDeadline=performance.now()+Math.max(0,d.retryAfterMs);connect();}catch{setTimeout(start,3000);}}void start();
