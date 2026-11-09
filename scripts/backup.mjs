import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, openSync, unlinkSync } from 'node:fs';
const [source,destination]=process.argv.slice(2);
if(!source || !destination || !existsSync(source)) throw Error('Usage: node scripts/backup.mjs EXISTING_DB NEW_BACKUP');
// Build and verify a private sibling file, then publish it atomically without overwrite.
const temporary=`${destination}.partial-${process.pid}-${randomBytes(8).toString('hex')}`;
closeSync(openSync(temporary,'wx',0o600));
function removeTemporary(){for(const path of [temporary,`${temporary}-wal`,`${temporary}-shm`]){try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}}}
try {
 const db=new DatabaseSync(source,{readOnly:true});
 try {await backup(db,temporary);} finally {db.close();}
 const copy=new DatabaseSync(temporary,{readOnly:true});
 try {const result=copy.prepare('PRAGMA integrity_check').get();if(result.integrity_check!=='ok')throw Error('Backup failed integrity check');} finally {copy.close();}
 linkSync(temporary,destination);
 console.log('Backup verified:',destination);
} catch(error) {
 try {removeTemporary();} catch(cleanupError) {console.error('Could not remove temporary backup files:',cleanupError);}
 throw error;
}
removeTemporary();
