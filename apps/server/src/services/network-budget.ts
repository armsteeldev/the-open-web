/** Process-local, bounded token bucket. Network addresses never reach disk or logs. */
export class NetworkBudget {
 private readonly entries = new Map<string, {tokens:number, updated:number}>();
 constructor(private readonly capacity=12, private readonly refillMs=1000, private readonly maxEntries=10000) {}
 private refill(entry:{tokens:number,updated:number}, now:number) {
  entry.tokens=Math.min(this.capacity,entry.tokens+Math.max(0,now-entry.updated)/this.refillMs);
  entry.updated=now;
 }
 take(key:string, now:number): number {
  let entry=this.entries.get(key);
  if(!entry) {
   if(this.entries.size>=this.maxEntries) {
    this.prune(now);
    if(this.entries.size>=this.maxEntries) return this.refillMs;
   }
   entry={tokens:this.capacity,updated:now};this.entries.set(key,entry);
  }
  this.refill(entry,now);
  if(entry.tokens<1)return Math.ceil((1-entry.tokens)*this.refillMs);
  entry.tokens-=1;return 0;
 }
 prune(now:number) { for(const [key,e] of this.entries) if(now-e.updated>=this.capacity*this.refillMs) this.entries.delete(key); }
 refund(key:string) {const e=this.entries.get(key);if(e)e.tokens=Math.min(this.capacity,e.tokens+1);}
}
