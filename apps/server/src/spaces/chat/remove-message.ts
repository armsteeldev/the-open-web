import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeChatMessage } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-message.js MESSAGE_ID\n');
    process.exitCode = 2;
    return;
  }
  const messageId = Number(argument);
  if (!Number.isSafeInteger(messageId)) {
    process.stderr.write('Message ID must be a positive safe integer.\n');
    process.exitCode = 2;
    return;
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('chat_messages', 'chat_idempotency', 'chat_message_removals')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=3').get() as { count: number } | undefined;
    if (schema.count !== 3 || migration?.count !== 1) throw new Error('Global Chat schema is not installed in this database');
    const removed = removeChatMessage(db, messageId);
    if (!removed) {
      process.stderr.write(`No recent Global Chat message with ID ${messageId}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Removed Global Chat message ${messageId}; connected clients will receive the removal event.\n`);
  } finally {
    db.close();
  }
}

run();
