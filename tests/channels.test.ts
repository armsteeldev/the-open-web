import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { MAX_REALTIME_MESSAGE_BYTES, SpaceChannels } from '../apps/server/src/realtime/channels.js';

test('registered spaces receive only their own versioned events and slow clients are removed', () => {
  const events: string[] = [];
  let terminated = false;
  const a = { readyState: 1, bufferedAmount: 0, send: (message: string) => events.push(`a:${message}`) } as unknown as WebSocket;
  const b = { readyState: 1, bufferedAmount: 0, send: (message: string) => events.push(`b:${message}`) } as unknown as WebSocket;
  const slow = { readyState: 1, bufferedAmount: 65_536, terminate: () => { terminated = true; } } as unknown as WebSocket;
  const channels = new SpaceChannels(['wall', 'another']);

  assert.equal(channels.add(a, 'wall'), true);
  assert.equal(channels.add(a, 'another'), false);
  assert.equal(channels.add(b, 'another'), true);
  assert.equal(channels.add(slow, 'wall'), true);
  assert.equal(channels.add({} as WebSocket, 'unregistered'), false);
  assert.equal(channels.forSpace('wall').publish('pixel', { x: 4, y: 5, color: 2 }), true);
  assert.equal(events.length, 1);
  assert.match(events[0], /^a:/);
  assert.deepEqual(JSON.parse(events[0].slice(2)), { v: 1, space: 'wall', type: 'pixel', x: 4, y: 5, color: 2 });
  assert.equal(terminated, true);
  assert.equal(channels.size, 2);

  channels.delete(a);
  assert.equal(channels.forSpace('another').publish('update', { value: 1 }), true);
  assert.equal(events.length, 2);
  assert.match(events[1], /^b:/);
  assert.throws(() => channels.forSpace('unregistered'), /not registered/);
  assert.equal(channels.publish('missing', 'event', {}), false);
});

test('realtime envelopes reject reserved fields and oversized payloads', () => {
  const channels = new SpaceChannels(['wall']);
  assert.equal(channels.publish('wall', 'pixel', { v: 2 }), false);
  assert.equal(channels.publish('wall', 'pixel', { space: 'another' }), false);
  assert.equal(channels.publish('wall', 'pixel', { type: 'other' }), false);
  assert.equal(channels.publish('wall', 'Bad Type', {}), false);
  assert.equal(channels.publish('wall', 'pixel', { value: 'x'.repeat(MAX_REALTIME_MESSAGE_BYTES) }), false);
});
