import type { WebSocket } from 'ws';

/** One connection subscribes to one registered space for its lifetime. */
export class SpaceChannels {
 private readonly memberships = new Map<WebSocket,string>();
 get size() { return this.memberships.size; }
 add(socket:WebSocket, space:string) { this.memberships.set(socket,space); }
 delete(socket:WebSocket) { this.memberships.delete(socket); }
 sockets() { return this.memberships.keys(); }
 broadcast(space:string, event:unknown) {
  const payload=JSON.stringify(event);
  for(const [socket,channel] of this.memberships) {
   if(channel!==space || socket.readyState!==1) continue;
   try { if(socket.bufferedAmount>=65536) socket.terminate(); else socket.send(payload); } catch { socket.terminate(); }
  }
 }
}
