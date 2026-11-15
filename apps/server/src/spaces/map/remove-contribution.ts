import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeMapContribution } from './database.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function run(): void {
  const databasePath = process.env.DB_PATH;
  const digest = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !digest || process.argv.length !== 3 || !DIGEST_PATTERN.test(digest)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-contribution.js SHA256_VISITOR_DIGEST\n');
    process.stderr.write('Run only in a private operator shell. Never include the digest in public logs or reports.\n');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const table = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='map_contributions'").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=6').get() as { count: number } | undefined;
    if (table.count !== 1 || migration?.count !== 1) throw new Error('Visitors Map schema is not installed in this database');
    if (!removeMapContribution(db, digest)) {
      process.stderr.write('No contribution found for the supplied digest.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Removed the map contribution.\n');
  } finally {
    db.close();
  }
}

run();
