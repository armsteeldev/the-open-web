# Rollback compatibility

The ten-space candidate is being improved with append-only migration 007. A code rollback must leave the database in place, so the rollback target must recognize the exact schema added by every migration while keeping only the original three spaces active.

## Production baseline observed

On 2026-11-15, the public manifest reported `54c6364646ecd4a424eb85dbe89aa689fc725036`, and the host's `/opt/the-open-web/current` resolved to the same release. Public health was healthy. That release serves The Wall, Global Chat, and Message in a Bottle, with migration files only through 004. A privileged direct read of the production migration table was unavailable; no production database data was read or changed. No production writes, load tests, release activation, or backup creation occurred during this campaign.

The earlier `codex/final-expansion-rollback-bridge` branch at `25281d1698c55cbed139a5ac04420095002309ee` remains preserved. It recognizes exact schemas 004, 005, and 006. It does not recognize migration 007, so it cannot be the rollback target for the quality-campaign candidate after that migration is applied.

The new `codex/quality-campaign-rollback-bridge` branch is based on that preserved bridge. Commit `51d028dc54637d8beb03180f56899c31bd6b4c02` retains only Wall, Chat, and Bottle routes and migration files through 004, and validates exact later schemas 005, 006, and 007. It does not apply those later migrations.

## Required release order

1. Review the exact candidate and quality-campaign bridge commits. Run the guarded check-only release for both. These isolated checks do not contact production, activate code, apply production migrations, or create a production backup.
2. After separate production approval, activate the quality-campaign bridge as its own release. Verify the active manifest, actual process release, health, the three established spaces, and the applied schema through an authenticated operator read. The bridge serves no new spaces and does not apply migrations 005, 006, or 007.
3. Only after the bridge is verified as the active rollback target, run the candidate's exact-commit check-only release. A separately approved candidate activation then takes a fresh verified backup on the separate backup device before changing the release.
4. The activation gate rejects a candidate containing migration 007 unless the previous release's compiled `db.js` includes the exact 007 fingerprint. Keep the quality-campaign bridge as the rollback target after the candidate applies 007. Do not roll back to either the old production release or the older 004–006 bridge after 007 is present.

Bridge check-only checkout:

    git fetch origin
    git worktree add --detach /tmp/the-open-web-quality-bridge origin/codex/quality-campaign-rollback-bridge
    cd /tmp/the-open-web-quality-bridge
    npm run release -- --check-only

Candidate check-only checkout:

    git fetch origin
    git worktree add --detach /tmp/the-open-web-quality-candidate origin/main
    cd /tmp/the-open-web-quality-candidate
    npm run release -- --check-only

The normal release command is separate and requires its own approval. Check-only is not activation, backup, schema migration, or public verification.

## Exact compatibility rules

The bridge bundles migrations only through 004. It permits later applied versions only when each complete schema matches its SHA-256 fingerprint:

- 004 Bottle schema: `990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e`
- 005 four-space expansion schema: `de82a92961340220f02c40369d87637ffd1b65f9a890fa3537905ad987b9e229`
- 006 final-spaces schema: `718a3c10db4694071153003263cd695a6d322b6bf5bbce45d8bc379dabb8a046`
- 007 quality and drawing-retry schema: `194b28a6db6fe50aa6046346ce72a6d0c721e86ead70f340935ca32d9f4a8d36`

Migration 007 adds six idempotency foreign-key indexes, two Questions answer-order indexes, a bounded Drawing Board retry table, and its expiry index. The retry table stores no visitor digest and references drawings with `ON DELETE CASCADE`. Candidate startup validates every marker before accepting the migration history. Unknown versions, altered objects, partial schemas, and inconsistent histories fail closed.

## Disposable transition and recovery evidence

`tests/migration-forward-compat.test.ts` starts from a disposable migration-004 database, runs the three-space bridge, applies migrations 005–007 through real candidate startup, writes data to all ten spaces, retries a Drawing Board request key, and opens the same database with the bridge. It verifies that the three original APIs remain usable, new-space routes remain inactive, user-created rows and retry state remain stored, and SQLite integrity and foreign-key checks pass. Altered 005, 006, and 007 schemas and unknown migration histories are rejected.

`tests/rollback-bridge-schema.test.ts` on the new bridge branch independently opens exact schemas 004, 005, 006, and 007 and rejects altered schema and unknown-version fixtures. The release recovery tests also verify the 007 activation gate and that a service cannot be reported healthy when its process directory or manifest is wrong.

Production activation remains pending. The public service was observed on `54c6364646ecd4a424eb85dbe89aa689fc725036`; the quality candidate and bridge are local Git work until separately reviewed and approved for release.
