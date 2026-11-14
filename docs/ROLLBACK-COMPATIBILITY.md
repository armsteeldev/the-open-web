# Bottle migration rollback sequence

Production is on a release that knows migrations 001–003. It cannot be the rollback target once Bottle migration 004 is recorded.

## Required order

1. Deploy compatibility commit `48fc099192b9c4a783628c261e8fd6d58be8edcd` from `origin/codex/bottle-rollback-bridge` while production still has schema 003. This release contains the normal Wall and Chat application and the explicit migration-004 compatibility check. It does not include or apply migration 004.
2. Verify the bridge commit in the public release manifest and check local/public health. Its activation creates the regular verified SQLite backup.
3. From a clean checkout of `main`, deploy the Bottle release with `npm run release`. Activation refuses before backup or switching if migration 004 is present in the candidate but the current release's compiled migration runner lacks the Bottle compatibility fingerprint.

Use a detached worktree when releasing the bridge so the main checkout stays on the Bottle candidate:

```sh
git fetch origin
git worktree add --detach /tmp/the-open-web-bottle-bridge origin/codex/bottle-rollback-bridge
cd /tmp/the-open-web-bottle-bridge
npm run release
```

After the bridge is active and verified, run `npm run release` from a clean checkout of `main`. The bridge remains the rollback target for the Bottle release. Its migration runner accepts only the known migration-004 schema fingerprint; other unknown versions or a partial/altered Bottle schema fail startup. Code rollback leaves schema 004 and all three spaces' data untouched.

## Recovery verification

Both activation and manual rollback use `deploy/release-recovery.sh` when a post-switch failure occurs. Recovery reports success only after systemd is active, the service process working directory resolves to the restored immutable release, local and public health pass, and the public release manifest matches that release. A down service or a stale process cannot satisfy those checks. Recovery failure leaves the release directories and verified backup available for inspection and exits unsuccessfully.

`tests/migration-forward-compat.test.ts` starts the pre-Bottle Wall and Chat modules against a real database with migration 004 applied, then verifies health and preserved Wall, Chat, and Bottle data. It also confirms version 005 and altered migration-004 schemas remain rejected. `tests/release-recovery.test.ts` exercises the exact recovery helper for failed activation and failed manual rollback, simulates a service-down restart despite a false systemd active result, and checks the migration-004 deployment gate.
