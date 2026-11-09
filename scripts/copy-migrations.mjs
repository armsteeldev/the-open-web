import { cpSync, mkdirSync, rmSync } from 'node:fs';
// The destination is generated output; replace it so removed migrations cannot linger in a release.
rmSync('dist/database/migrations',{recursive:true,force:true});
mkdirSync('dist/database',{recursive:true});
cpSync('database/migrations','dist/database/migrations',{recursive:true});
