import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { SpaceChannels } from '../apps/server/src/realtime/channels.js';
test('events go only to the subscribed space and slow clients are disconnected',()=>{
 const events:string[]=[];let terminated=false;
 const a={readyState:1,bufferedAmount:0,send:(s:string)=>events.push('a:'+s)} as unknown as WebSocket;
 const b={readyState:1,bufferedAmount:0,send:(s:string)=>events.push('b:'+s)} as unknown as WebSocket;
 const slow={readyState:1,bufferedAmount:65536,terminate:()=>{terminated=true;}} as unknown as WebSocket;
 const channels=new SpaceChannels();channels.add(a,'wall');channels.add(b,'another');channels.add(slow,'wall');
 channels.broadcast('wall',{v:1,type:'pixel'});assert.equal(events.length,1);assert.match(events[0],/^a:/);assert.equal(terminated,true);
 channels.delete(a);channels.broadcast('another',{v:1,type:'update'});assert.equal(events.length,2);assert.match(events[1],/^b:/);
});
