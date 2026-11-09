# Deployment preparation — not yet deployed

On 2026-11-09 read-only inspection found Caddy active, Node 22.23.4 available, and no system `open-web` account, `/opt/the-open-web`, `/var/lib/the-open-web`, or `/etc/the-open-web.env`. Local development processes owned by the workspace user were listening on 127.0.0.1:4321 and :4322; final release checks used separate temporary ports and did not restart them. The intended hostname did not resolve in the host resolver. Noninteractive sudo was unavailable and Caddy's local admin API denied read access, so the live Caddy site map and firewall state could not be verified. Root had about 58 GiB free and swap was nearly full at inspection; neither is a deployment capacity approval. These are point-in-time observations. Recheck DNS, ports, available memory/swap and services before release. Do not alter the Armsteel portfolio. Determine the correct public server address and configure the A/AAAA record with the DNS operator; no record was changed here.

`deploy/Caddyfile.site` and `deploy/open-web.service` are templates, not installed or production-validated. Before activation, establish a dedicated `open-web` user, `/var/lib/the-open-web` owned by it with mode 0700, `/etc/the-open-web.env` readable only by the service, and immutable versioned releases in `/opt/the-open-web/releases/`; point `current` at the chosen release. Install all dependencies on the build host, run the full pre-deployment checks, then install only production dependencies for the compiled server. The build copies migrations under `dist/database/migrations`; ship both `dist` and `apps/web/dist`, plus the package manifest and lockfile. Use an absolute DB_PATH. Set `ORIGIN=https://open.armsteel.dev`, `COOKIE_SECURE=true`, `WRITES_ENABLED=true`, `PORT=4322`, and a root-owned, service-readable `WRITE_GATE_PATH=/etc/the-open-web/writes-disabled` in a 0750 directory owned by `root:open-web` for an immediate write stop. The cooldown is fixed at 10 seconds. Test the gate before public access. Do not overwrite an existing directory or service.

Inspect the actual Caddyfile and its trust-proxy configuration. Integrate the separate site block according to current conventions; validate the *complete* candidate configuration with `caddy validate` before a controlled reload. The site template overwrites both `X-Forwarded-For` and `X-Real-IP` with Caddy's `client_ip`; Fastify trusts forwarded IP attribution only from peer `127.0.0.1`, and the backend binds only to that loopback address. Do not pass client-supplied forwarding headers through unchanged or widen Fastify's trusted proxy range. If Cloudflare or another proxy is placed in front of Caddy, configure only its verified address ranges in Caddy's global `trusted_proxies` setting and verify `client_ip` using both legitimate and forged headers. Ensure Caddy can traverse and read the release. Validate HTTPS, health, WebSocket, cookie and two-visitor behaviour, plus existing sites immediately after activation. If any gate fails, stop; no production activation has been done.

## Repeatable release procedure

Run these checks from a clean checkout on Node 22.23.4 or later in the 22.x line. `node:sqlite` is still marked Active development by the Node 22 documentation; this release candidate keeps it because the exact target runtime was exercised for migrations, concurrent writes, WAL backup/restore, compiled startup and shutdown. Pin and record the deployed Node patch, and rerun these checks whenever it changes. The database API is synchronous and must remain a single backend process.

```sh
npm ci
npm audit
npm run lint
npm run typecheck
npm test
npm run build
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
npm run test:production
CHROMIUM_PATH=/usr/bin/chromium npm run test:built
npm run test:load
```

Use the actual Chromium executable path. Create a release directory named for the verified Git commit under `/opt/the-open-web/releases/`. Copy `dist/`, `apps/web/dist/`, `scripts/backup.mjs`, `scripts/test-production.mjs`, `package.json`, and `package-lock.json` into it, then run `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` there and `npm run test:production`. The smoke test starts the compiled backend with a fresh disposable database and verifies a placement without touching the configured production database. It must pass before activation. Release files should be owned by a deployment account and readable/traversable by `open-web` and Caddy; only `/var/lib/the-open-web` is writable by the service. Confirm the configured absolute `DB_PATH` points there and the persistent directory is mode 0700.

`npm run test:load` has no target-URL option; it always starts its own backend on loopback with a new disposable database and tests up to the configured 500-connection limit. Run it only on a development or release host with enough spare memory.

Before switching, verify the previous `current` target, ensure sufficient approved backup space, and create a new backup using [BACKUPS.md](BACKUPS.md) when a database already exists. On first installation there is no database to back up and no previous release to roll back to; record that no prior target exists. Verify any backup and record its path. Migrations run transactionally before the backend starts listening. Change no database path or unrelated service. Prepare a temporary symlink and atomically rename it over `current`, then restart only `the-open-web`. Check the local health endpoint, HTTPS page, Secure session cookie, WebSocket state and a real placement through Caddy. If any post-activation check fails, switch `current` back to the recorded previous release when available, restart only this service, and recheck health. Check Caddy's configuration before its controlled reload only if its site block was changed; do not reload Caddy as part of application-only releases.

Example activation after provisioning and review (replace the release ID and backup destination with approved values):

```sh
set -eu
release_id=COMMIT_SHA
release=/opt/the-open-web/releases/$release_id
previous=
if [ -L /opt/the-open-web/current ]; then previous=$(readlink -f /opt/the-open-web/current); fi
if [ -f /var/lib/the-open-web/open-web.sqlite ]; then node "$release/scripts/backup.mjs" /var/lib/the-open-web/open-web.sqlite /approved/backup/path/open-web-TIMESTAMP.sqlite; fi
ln -s "$release" /opt/the-open-web/.current.next
mv -Tf /opt/the-open-web/.current.next /opt/the-open-web/current
systemctl restart the-open-web
curl --fail --silent http://127.0.0.1:4322/api/health
curl --fail --silent --show-error https://open.armsteel.dev/api/health
```

For code rollback, atomically switch `current` to the recorded previous immutable release and restart only `the-open-web`; this option is available after the first successful activation. Do not restore a database automatically. Code rollback does not reverse migrations and never removes newer pixel writes. Each migration must be reviewed for backward compatibility before release; when the preceding binary cannot read a migrated schema, keep the service stopped or roll forward with a fix. Restore a verified backup only as an explicit data-loss recovery decision, after preserving the current database and its WAL/SHM files.

```sh
ln -s "$previous" /opt/the-open-web/.current.rollback
mv -Tf /opt/the-open-web/.current.rollback /opt/the-open-web/current
systemctl restart the-open-web
curl --fail --silent http://127.0.0.1:4322/api/health
curl --fail --silent --show-error https://open.armsteel.dev/api/health
```

## Emergency write shutdown

Create the configured flag as a root-owned file readable by the service:

```sh
install -o root -g open-web -m 0640 /dev/null /etc/the-open-web/writes-disabled
```

Writes stop on the next mutating request across HTTP mutation routes; the WebSocket is read-only and does not accept client messages. Confirm by attempting an authorized test placement and observing HTTP 503. To re-enable, remove only that flag after resolving the incident, check `/api/health`, then make and verify one placement. If the flag's parent cannot be read, writes fail closed. Alternatively set `WRITES_ENABLED=false` in the environment file and restart only this service.

No production DNS, systemd unit, data directory, Caddy configuration or public deployment was changed or validated in place during release preparation. Domain/DNS, privileged host provisioning, final live Caddy integration, physical-device checks, and manual screen-reader checks remain acceptance steps. Browser emulation and axe WCAG 2.1 A/AA checks passed; they do not replace those manual checks.
