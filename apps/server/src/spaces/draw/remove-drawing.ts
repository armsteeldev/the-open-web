import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { removeDrawing } from './database.js';

function run(): void {
  const databasePath = process.env.DB_PATH;
  const argument = process.argv[2];
  if (!databasePath || !isAbsolute(databasePath) || !argument || process.argv.length !== 3 || !/^[1-9][0-9]{0,11}$/.test(argument)) {
    process.stderr.write('Usage: DB_PATH=/absolute/path/to/open-web.sqlite node remove-drawing.js DRAWING_ID\n');
    process.exitCode = 2;
    return;
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('Drawing ID must be a positive safe integer.\n');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const table = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('draw_drawings', 'draw_visitor_cooldowns')").get() as { count: number };
    const migration = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=6').get() as { count: number } | undefined;
    if (table.count !== 2 || migration?.count !== 1) throw new Error('Drawing Board schema is not installed in this database');
    if (!removeDrawing(db, id)) {
      process.stderr.write('No drawing with ID ' + id + '.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Removed drawing ' + id + '.\n');
  } finally {
    db.close();
  }
}

run();
