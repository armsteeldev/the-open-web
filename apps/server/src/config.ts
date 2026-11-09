import { isAbsolute } from 'node:path';
export const PLACEMENT_COOLDOWN_MS=10000;
export function readConfig(env:NodeJS.ProcessEnv) {
 const bool=(name:string, fallback:boolean)=>{const value=env[name];if(value===undefined)return fallback;if(value==='true')return true;if(value==='false')return false;throw new Error(`${name} must be true or false`);};
 const port=Number(env.PORT ?? 4322),cooldown=PLACEMENT_COOLDOWN_MS;
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer between 1 and 65535');
 if(env.COOLDOWN_MS!==undefined && env.COOLDOWN_MS!==String(PLACEMENT_COOLDOWN_MS))throw new Error(`COOLDOWN_MS is fixed at ${PLACEMENT_COOLDOWN_MS}`);
 const origin=env.ORIGIN ?? 'http://localhost:4321';let parsed:URL;
 try {parsed=new URL(origin);} catch {throw new Error('ORIGIN must be an HTTP(S) origin');}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)throw new Error('ORIGIN must be an exact HTTP(S) origin without a path or trailing slash');
 const secure=bool('COOKIE_SECURE',false),writes=bool('WRITES_ENABLED',true);
 if(parsed.protocol==='https:' && !secure)throw new Error('HTTPS origin requires COOKIE_SECURE=true');
 const dbPath=env.DB_PATH ?? './data/open-web.sqlite';if(!dbPath.trim())throw new Error('DB_PATH must not be empty');
 const writeGatePath=env.WRITE_GATE_PATH;if(writeGatePath!==undefined && (!writeGatePath.trim() || !isAbsolute(writeGatePath)))throw new Error('WRITE_GATE_PATH must be an absolute path');
 return {port,dbPath,origin,cooldown,writes,secure,writeGatePath};
}
