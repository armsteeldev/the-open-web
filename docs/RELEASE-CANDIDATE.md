# The Wall release candidate

Release ID: `wall-rc-1`  
Application source and full clean-checkout verification: commit `f87bfcc2cd52`  
Runtime: Node.js `v22.23.4`  
Verification date: 2026-11-09 UTC

The full verification ran from a fresh `git archive` of the source commit. Follow-up commits after it change documentation only; no application code changed after verification. No push, release tag, or production deployment was made.

## Verification

- `npm ci`: 358 packages installed; zero audit findings.
- Lint, type checking, all 22 automated tests, and production build passed.
- Chromium desktop and mobile emulation passed keyboard, touch, pinch zoom, orientation, refresh, multi-visitor, reconnection, stale-snapshot and WCAG 2.1 A/AA axe checks.
- The compiled server passed with production-only dependencies. An isolated Caddy HTTPS instance passed configuration validation, routing, CSP, Secure cookies, WebSocket upgrade, and forwarding-header spoof tests.
- Disposable WAL backup, integrity check, restore, application startup, preserved and new pixels, no-overwrite behavior, and hard-process-crash recovery passed.
- `systemd-analyze verify deploy/open-web.service` passed.
- Isolated load test passed at 1, 10, 25, 50, 100, 250 and 500 visitors; visitor 501 was rejected at the configured connection limit.

## Release status

**CONDITIONALLY READY.** The application code passed pre-deployment verification. Read-only public checks on 2026-11-09 at 23:00 UTC found `open.armsteel.dev` resolving through `mpmc.ddns.net` to `188.149.200.166`; HTTP redirected to HTTPS, but HTTPS failed during TLS negotiation with an `internal error` alert. The production service account, directories and environment file are not provisioned, and the live Caddy site map could not be read. Do not publish until the intended server address and live HTTPS route are confirmed and the service is provisioned using [DEPLOYMENT.md](DEPLOYMENT.md).

Physical-device and manual screen-reader checks also remain. Chromium emulation and automated accessibility checks do not replace them.
