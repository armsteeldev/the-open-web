# Expansion Phase I rollback compatibility

Migration 005 adds the Guestbook, The Story, Open Questions, and The Choice tables to the existing schema 004 database. The current three-space release can serve schema 004, but cannot start against migration 005 unless its migration runner recognizes the exact new schema. Deploy the small compatibility bridge before the feature release.

## Required order

1. Before activation, confirm the actual production release and database are still on the established three-space application and schema 004. Check the running process, public release manifest, local/public health, and read the database migration table through the configured `DB_PATH`. Do not rely on this document's historical baseline.
2. Check out `origin/codex/expansion-phase-i-rollback-bridge` at commit `057108a9bf73f503771fbea37f86b68a60e60149`. This bridge retains The Wall, Global Chat, and Message in a Bottle, contains no migration 005, and does not register any new space. Its runner recognizes only the exact validated 005 fingerprint in addition to the known 004 schema. Run its exact-commit `npm run release -- --check-only` first; activate it only as a separate approved release.
3. Verify the bridge commit in the public release manifest, local/public health, all three established pages, and the database still at schema 004. The normal activation creates and verifies the regular SQLite backup.
4. From a clean checkout of `main`, run `npm run release -- --check-only` for the feature commit. After review, a separately approved `npm run release` can activate the seven-space candidate. Activation refuses before backup or switching unless the active bridge contains the exact schema 005 fingerprint (and the known schema 004 marker).

The branch is prepared separately so it can be checked out on the production host without moving the candidate checkout:

```sh
git fetch origin
git worktree add --detach /tmp/the-open-web-expansion-bridge origin/codex/expansion-phase-i-rollback-bridge
cd /tmp/the-open-web-expansion-bridge
npm run release -- --check-only
```

The feature activation applies migration 005 transactionally. If it fails after switching, the recovery helper returns to the bridge only after systemd, runtime directory, local/public health, and public manifest match the bridge. The bridge opens the known 005 schema but still serves only the original three spaces; expansion table data remains in SQLite for a later candidate. A code rollback does not restore the database. Any release older than the new bridge is an unsafe rollback target after migration 005.

## What the bridge validates

The bridge contains migrations only through 004. It permits one applied schema version beyond its migration files: version 005 with an exact fingerprint over all `guestbook_*`, `story_*`, `questions_*`, and `choice_*` objects. It rejects unexpected migration versions and altered or partial schema 005. The candidate contains the same 004 and 005 validation, so release recovery and later normal rollbacks retain strict schema validation.

## Verification

`tests/migration-forward-compat.test.ts` starts a real Fastify app on schema 004 with the bridge's three module registrations, starts the all-seven candidate and applies 005, then starts the three-space bridge again against schema 005. It verifies Wall, Chat, and Bottle data survive, all four new APIs persist data before rollback, the bridge does not expose new routes, and SQLite integrity and foreign keys remain sound. It also rejects altered 005 and unexpected versions. `tests/release-recovery.test.ts` exercises failed activation recovery and failed manual rollback recovery, simulates a down service despite a false active result, and verifies the release gate requires both exact schema fingerprints.

The final exact-commit `npm run release -- --check-only` runs the whole suite, including the isolated migration sequence. A check-only release creates no production backup and changes no production state.
