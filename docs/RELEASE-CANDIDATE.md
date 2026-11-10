# Wall release verification record

The release process is now maintained in [DEPLOYMENT.md](DEPLOYMENT.md). Run `npm run release -- --check-only` to repeat the current full verification against a clean committed checkout; that command reports the exact commit it checked and does not change production.

## Production deployment — 2026-11-10

Commit `5c7fc8458aa1edbdc512691d9553cf8f2f197b56` was activated at `/opt/the-open-web/releases/5c7fc8458aa1edbdc512691d9553cf8f2f197b56`. The service recovered after activation and public/local health checks passed. A verified SQLite backup was saved to `/mnt/continental-cloud/backups/the-open-web/open-web-before-5c7fc84.sqlite` on the separate HDD.

The public site was checked after release: desktop and mobile wall layout, initial coordinate display, status and palette, Spaces and Help controls, session cooldown duration, and browser console health. Future releases should use the automated procedure in `DEPLOYMENT.md`, which performs those release gates and polls readiness before considering activation successful.
