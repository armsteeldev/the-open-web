import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../apps/server/src/config.js';
test('configuration fails closed for invalid switches, origins and ports',()=>{
 assert.equal(readConfig({}).cooldown,10000);
 assert.equal(readConfig({WRITES_ENABLED:'false'}).writes,false);
 assert.equal(readConfig({COOLDOWN_MS:'10000'}).cooldown,10000);
 for(const env of [{WRITES_ENABLED:'flase'},{COOKIE_SECURE:'yes'},{PORT:'NaN'},{PORT:''},{PORT:'0'},{COOLDOWN_MS:'5000.5'},{COOLDOWN_MS:'5000'},{COOLDOWN_MS:'15000'},{ORIGIN:'https://example.test'},{ORIGIN:'https://example.test/path',COOKIE_SECURE:'true'},{WRITE_GATE_PATH:'relative'},{WRITE_GATE_PATH:''}])assert.throws(()=>readConfig(env));
 assert.equal(readConfig({ORIGIN:'https://example.test',COOKIE_SECURE:'true'}).secure,true);
});
