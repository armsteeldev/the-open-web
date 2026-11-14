import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeBottle } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-bottle.js BOTTLE_UUID\n');
    process.exitCode = 2;
    return;
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('bottle_messages', 'bottle_visitor_cooldowns', 'bottle_idempotency')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=4').get() as { count: number } | undefined;
    if (schema.count !== 3 || migration?.count !== 1) throw new Error('Message in a Bottle schema is not installed in this database');
    if (!removeBottle(db, argument.toLowerCase())) {
      process.stderr.write(`No Message in a Bottle record with ID ${argument}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Removed Message in a Bottle record ${argument}.\n`);
  } finally {
    db.close();
  }
}

run();
