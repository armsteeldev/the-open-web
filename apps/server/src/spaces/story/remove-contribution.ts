import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeStoryContribution } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-contribution.js CONTRIBUTION_ID\n');
    process.exitCode = 2;
    return;
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('Contribution ID must be a positive safe integer.\n');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const table = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('story_chapters', 'story_contributions', 'story_idempotency')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=5').get() as { count: number } | undefined;
    if (table.count !== 3 || migration?.count !== 1) throw new Error('The Story schema is not installed in this database');
    if (!removeStoryContribution(db, id)) {
      process.stderr.write(`No unredacted Story contribution with ID ${id}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Redacted Story contribution ${id}; its place in the chapter remains.\n`);
  } finally {
    db.close();
  }
}

run();
