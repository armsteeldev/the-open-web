import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChatTime } from '../apps/web/src/spaces/chat/presentation.js';

test('chat timestamps use local 24-hour time and add a date at a local midnight boundary', () => {
  const sameLocalDay = formatChatTime(
    Date.UTC(2026, 1, 2, 1, 5),
    Date.UTC(2026, 1, 2, 2, 0),
    'en-US',
    'America/Los_Angeles',
  );
  assert.equal(sameLocalDay.text, '17:05');
  assert.match(sameLocalDay.accessibleLabel, /February 1, 2026/);

  const acrossLocalMidnight = formatChatTime(
    Date.UTC(2026, 1, 2, 7, 55),
    Date.UTC(2026, 1, 2, 8, 5),
    'en-US',
    'America/Los_Angeles',
  );
  assert.equal(acrossLocalMidnight.text, 'Feb 1 23:55');
  assert.match(acrossLocalMidnight.accessibleLabel, /February 1, 2026/);
  assert.match(acrossLocalMidnight.accessibleLabel, /PST/);
});
