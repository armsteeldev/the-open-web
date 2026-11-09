import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
/** A configured gate fails closed if its parent cannot be inspected. */
export function writesBlocked(path:string|undefined):boolean {
 if(!path)return false;
 try {if(!statSync(dirname(path)).isDirectory())return true;} catch {return true;}
 try {lstatSync(path);return true;} catch(error) {return (error as NodeJS.ErrnoException).code!=='ENOENT';}
}
