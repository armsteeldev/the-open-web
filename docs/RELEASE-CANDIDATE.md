# Release verification record

The automated release procedure is maintained in [DEPLOYMENT.md](DEPLOYMENT.md). Run `npm run release -- --check-only` against a clean commit for complete verification without changing production. The guarded activation through `npm run release` records the deployed commit and fresh backup path.

## Production baseline checked — 2026-11-10

Before the multi-space foundation changes, the production host's current symlink resolved to `f43cccde2ee4f75a6e110af35cfd7fa2ac0fe335`. The public release manifest matched, and local and public health checks succeeded. This replaced the older `5c7fc8458aa1edbdc512691d9553cf8f2f197b56` deployment note, which did not describe the live host at the time of this check.

Any deployment of the foundation must be recorded here with the exact activated SHA, verified backup path, and post-activation public checks. A check-only result is not a deployment.
