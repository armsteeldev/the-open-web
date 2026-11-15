# Expansion Phase I compatibility bridge

This release is the forward-compatible bridge for database migration 005. It is based on the three-space release that already knows Bottle migration 004. It continues serving The Wall, Global Chat, and Message in a Bottle, contains migration files only through 004, and does not register Guestbook, The Story, Open Questions, or The Choice.

The bridge runner permits one exact later schema: migration 005's four additive space-owned table groups. It checks the `sqlite_schema` fingerprint before startup succeeds. It continues to reject migration versions it does not know and altered or partial 005 schemas. The bridge does not apply or reverse migration 005; after code rollback to it, expansion data remains in SQLite while the established three spaces continue to work.

Deploy this branch before the seven-space candidate applies migration 005. The release activation check on the candidate requires the active rollback target to contain the exact 004 and 005 fingerprints. Follow the guarded sequence in [DEPLOYMENT.md](DEPLOYMENT.md), and verify the database and running release at activation time rather than relying on a stale baseline.

The full end-to-end startup sequence is tested from the feature candidate with disposable schema-004 and schema-005 databases. The bridge's own tests keep its established Wall, Chat, and Bottle behavior intact and reject an unknown future-version marker and malformed known Bottle schema.
