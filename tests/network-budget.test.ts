import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBudget } from '../apps/server/src/services/network-budget.js';
test('network budget limits identity rotation, refills, and bounds memory',()=>{
 const budget=new NetworkBudget(3,10000,2);
 assert.equal(budget.take('a',0),0);assert.equal(budget.take('a',0),0);assert.equal(budget.take('a',0),0);assert.equal(budget.take('a',0),10000);
 assert.equal(budget.take('b',0),0);assert.equal(budget.take('c',0),10000);
 assert.equal(budget.take('a',10000),0);assert.equal(budget.take('a',10000),10000);
 budget.refund('a');assert.equal(budget.take('a',10000),0);
 assert.equal(budget.take('c',40000),0);
});
