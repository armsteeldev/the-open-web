import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeChoiceDecision } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-decision.js DECISION_ID\n');
    process.exitCode = 2;
    return;
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('Decision ID must be a positive safe integer.\n');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('choice_decisions', 'choice_votes', 'choice_proposal_idempotency')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=5').get() as { count: number } | undefined;
    if (schema.count !== 3 || migration?.count !== 1) throw new Error('The Choice schema is not installed in this database');
    if (!removeChoiceDecision(db, id)) {
      process.stderr.write(`No The Choice proposal or decision with ID ${id}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Removed The Choice decision ${id}; the next queued decision was activated if available.\n`);
  } finally {
    db.close();
  }
}

run();
