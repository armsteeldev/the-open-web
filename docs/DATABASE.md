# Database

The platform uses one SQLite database in WAL mode with a 5-second busy timeout. Node.js 22's built-in `node:sqlite` API provides one shared connection in the single Fastify process. No database server or cache is involved.

## Ownership and data access

Each space owns its tables, constraints, indexes, transactions, and query functions. Keep them beside its backend module, for example `apps/server/src/spaces/wall/database.ts`. Prefix new table and index names with the stable space ID to make ownership clear. Do not import another space's data-access code or query its tables. The database connection is shared, so ownership is an application convention rather than SQLite-enforced per-module permissions.

The existing Wall tables are `wall_tiles` and `visitor_cooldowns`. They keep their released names and format for compatibility. `wall_tiles` stores a 10,000-byte row-major palette-index blob for each touched 100 × 100 tile, keyed by tile coordinates. The Wall validates tile size and palette indices before reading or writing. `visitor_cooldowns` stores a SHA-256 digest and last placement time. Migration 002 indexes its timestamps so expired digests can be purged in batches. Neither table stores network addresses.

The Wall wraps expiry cleanup, cooldown check, tile overwrite, and cooldown update in `BEGIN IMMEDIATE`; failures roll back. Its behavior remains an overwrite, with the latest committed pixel and event order aligned. There is no automatic Wall reset.

## Migrations

Migration 003 creates three Global Chat-owned tables. `chat_messages` stores the autoincrement ID, server timestamp, shared visitor digest, nickname and plain text, with indexes for recent history and repeated-text checks. `chat_idempotency` stores a visitor digest, UUID request key, accepted message ID and timestamp; entries expire after one hour and are capped at 10,000. Its visitor/time index also backs the three-second cooldown when a message row is removed. `chat_message_removals` holds bounded ID/time tombstones so the running process can publish removals made by retention, the hard count cap, or the operator command. Message text is limited to 360 UTF-8 bytes and nickname to 24 Unicode code points/48 UTF-8 bytes. Messages expire after 24 hours and the table is capped at 2,000 rows. No IP address is stored.

Files in `database/migrations` use consecutive three-digit numbers and an owner/purpose suffix, such as `004_example_records.sql`. The runner applies each migration and its version record in one transaction. Gaps, duplicate numbering, failed SQL, newer database history, and inconsistent histories fail closed. A failed migration rolls back its schema changes. There is no automatic reverse migration.

Once released, a migration file is immutable. Make the next schema change in a new numbered file. Keep a migration narrow and compatible with the previously deployed application: code rollback does not automatically roll back a database. Do not add tables for spaces that have not been built. Test new migrations on a disposable database and verify that existing Wall rows and tables remain intact.

## Backup and restore

Before production schema changes, follow [BACKUPS.md](BACKUPS.md). `scripts/backup.mjs` uses SQLite's online backup API, verifies integrity including committed WAL content, writes with private permissions, publishes atomically, and refuses to overwrite an existing backup. Production activation requires a fresh verified backup on the approved separate HDD before switching releases.

Test restores on disposable copies. Never replace an active WAL database beneath the running service. For actual recovery, preserve the current database plus WAL/SHM files, use a verified backup, stop only the Open Web service, and follow the documented recovery checks. Restoring an older backup discards writes after its snapshot.
