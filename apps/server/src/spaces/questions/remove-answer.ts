import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeAnswer } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-answer.js ANSWER_ID\n');
    process.exitCode = 2;
    return;
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('Answer ID must be a positive safe integer.\n');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('questions_items', 'questions_answers', 'questions_item_idempotency', 'questions_answer_idempotency')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=5').get() as { count: number } | undefined;
    if (schema.count !== 4 || migration?.count !== 1) throw new Error('Open Questions schema is not installed in this database');
    if (!removeAnswer(db, id)) {
      process.stderr.write(`No Open Questions answer with ID ${id}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Removed Open Questions answer ${id}.\n`);
  } finally {
    db.close();
  }
}

run();
