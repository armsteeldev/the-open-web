# Final expansion rollback compatibility

The ten-space candidate adds migrations 005 and 006. Those additions are append-only, so a code rollback must leave the database in place. The rollback target must be able to start on schema 004, 005, and 006 while serving only the three spaces that were active in production before the final expansion.

## Production baseline observed for this assignment

On 2026-11-15, the public release manifest reported **54c6364646ecd4a424eb85dbe89aa689fc725036** and public health was healthy. That release contains only The Wall, Global Chat, and Message in a Bottle. Its runner bundles migrations through 004 and rejects any later migration version. A healthy process running that code is evidence that the production database is on the 004-compatible schema. A privileged direct read of the migration table was not available during preparation; production data was not read or changed.

The compatibility bridge is prepared on a separate branch based directly on that live release. It contains the three existing pages and API modules, migrations only through 004, and exact schema fingerprints for 004, 005, and 006. It neither applies migration 005 or 006 nor registers Guestbook, The Story, Open Questions, The Choice, The Drawing Board, The Garden, or Visitors Map.

Prepared bridge commit: **`25281d1698c55cbed139a5ac04420095002309ee`** on `codex/final-expansion-rollback-bridge`.

## Required release order

1. Review the ten-space candidate and the separate bridge commit. Run the exact-commit check-only release for both. These checks use disposable databases and do not activate code or create a production backup.
2. After separate production approval, activate the bridge as its own release. Verify the public manifest and health, the three established pages and APIs, and the migration version through an authenticated operator database read. The bridge release itself does not change the schema.
3. Only after the bridge is the verified active release, run the exact-commit check-only release on the ten-space candidate. A separately approved normal release may then activate it. The activation gate rejects the candidate unless the previous release's compiled database runner contains the exact 004, 005, and 006 compatibility fingerprints.
4. Keep the bridge as the rollback target after migration 005 or 006 has been applied. Do not roll code back to the older 54c636 release after either later schema is present; that runner does not recognize those schemas.

Bridge check-only checkout:

    git fetch origin
    git worktree add --detach /tmp/the-open-web-final-bridge origin/codex/final-expansion-rollback-bridge
    cd /tmp/the-open-web-final-bridge
    npm run release -- --check-only

Candidate check-only checkout:

    git fetch origin
    git worktree add --detach /tmp/the-open-web-final-candidate origin/main
    cd /tmp/the-open-web-final-candidate
    npm run release -- --check-only

The normal release command must be run separately and only after review. It applies migrations, creates and verifies the regular production backup, and switches the application. This assignment prepares the candidate and bridge but leaves production activation pending approval.

## Compatibility rules

The bridge bundles migrations only through 004. Its runner permits the known later applied versions 005 and 006 only when each complete owned schema matches its SHA-256 fingerprint:

- 004 Bottle schema: 990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e
- 005 four-space expansion schema: de82a92961340220f02c40369d87637ffd1b65f9a890fa3537905ad987b9e229
- 006 final-spaces schema: 718a3c10db4694071153003263cd695a6d322b6bf5bbce45d8bc379dabb8a046

Every fingerprint covers the tables, indexes, constraints, and keys owned by that migration. Unknown versions, altered schemas, missing migration files, and partial application fail closed. The candidate runner applies 005 and 006 in separate transactions, validates each schema before recording its version, and recognizes the same exact fingerprints for later code rollback.

## Full transition and failure simulation

The migration-forward compatibility test uses a disposable database starting at the migration-004 production baseline. It starts the three-space bridge, confirms the newer routes are absent, then starts the ten-space candidate and applies 005 and 006 through real application startup. The candidate writes a representative drawing larger than the shared 1 KiB body limit, a garden plant, and a voluntary country contribution, alongside data for the four spaces from migration 005.

The test then closes the candidate and starts the bridge against the same database, simulating activation failure and code rollback without restoring a database backup. It verifies Wall, Chat, and Bottle still serve data; all final-space routes remain inactive; all new rows remain stored; migration history is 006; and SQLite integrity and foreign keys pass. A separate test rejects unexpected version 007 and altered 005 or 006 schemas. The full test suite also validates candidate activation's schema gate and the release recovery helper.

Check-only packaging is not an activation, production backup, database migration, or deployment. The public service remains on its currently observed release until a separate production approval.
