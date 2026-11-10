# Production deployment

## Release with one command

From the project checkout, commit the changes you intend to publish, then run:

```sh
npm run release
```

The command builds and checks the exact clean Git commit in a fresh temporary checkout. It runs dependency installation and audit, lint, type checking, unit tests, production build, browser checks, production dependency smoke test, isolated Caddy routing test, and the 500-visitor load check. It creates a checksummed package containing that build. Only after those steps pass does it request sudo for production activation. Enter the sudo password in the terminal when prompted.

Use the check-only form to run the complete verification and package the commit without changing production:

```sh
npm run release -- --check-only
```

The check-only command verifies and packages the commit without contacting the production service or changing production. The activation path in `npm run release` then checks host health, service configuration, backup-device separation, backup-directory ownership and permissions, available space, and the fresh SQLite backup before switching releases. Chromium is detected automatically; set `CHROMIUM_PATH` only if it is installed in a nonstandard location.

To choose a different approved backup directory:

```sh
npm run release -- --backup-dir /absolute/path/to/private-backup-directory
```

The default is `/mnt/continental-cloud/backups/the-open-web`. The activation step checks that the directory exists, is root-owned and private, has enough free space, and is on a different mounted device from the live database. It verifies the SQLite online backup before changing the active release.

## What activation checks

The privileged activation helper reads `PORT` and `DB_PATH` from the running service, checks local and public health before deployment, installs only production dependencies into a staged release, and runs the compiled production smoke test against a disposable database. It makes the release readable to the service and Caddy, then removes write permission. It backs up the active SQLite database, atomically switches `/opt/the-open-web/current`, and restarts only `the-open-web`.

Readiness checks poll for up to 60 seconds after restart. They require a healthy local and public API, a public release manifest that matches the full commit ID, a numeric cooldown duration from the session API, the expected Wall controls, and a valid Chat history response and page with both navigation entries. If activation fails after switching, the helper restores the prior symlink, restarts the prior release, and checks health again. It retains the verified backup. Deployment and rollback share a lock so they cannot run at the same time.

The exact production hostname is `https://open.armsteel.dev`; Caddy forwards API requests to loopback port `4323`. The activation script reads the actual configured port and database path from the running service rather than assuming either value. Application-only releases do not reload Caddy.

## Code rollback

The activation helper records the previous immutable release. To switch back to it:

```sh
npm run rollback
```

This asks for sudo, atomically changes `current`, restarts only the app, and checks health. If the rollback release fails readiness, it restores the release that was active before the rollback. Code rollback does not restore or replace the database. Schema changes must remain compatible with the preceding release; restoring a database is a separate recovery decision described in [BACKUPS.md](BACKUPS.md).

## Production baseline checked for the multi-space foundation

At the start of this work on 2026-11-10, the Ubuntu 24.04 production host was running the supplied baseline commit `f43cccde2ee4f75a6e110af35cfd7fa2ac0fe335`. `/opt/the-open-web/current` resolved to that immutable release, the public `/release.json` matched it, and local and public health checks passed. The service answered on port `4323`. The approved backup directory exists on the mounted HDD at `/mnt/continental-cloud`; activation verifies that device against the actual database path and creates a fresh backup before every release.

This is the baseline for this foundation task, not a live release lookup. After a release, the full commit ID printed by the activation command and the public release manifest identify the running version. This checkout deploys locally to the host where the command runs; it does not push to a remote repository or depend on CI. Keep release and rollback commands on the production host.

## Host configuration contract

The production layout is `/opt/the-open-web/releases/<full-commit>/`, with `/opt/the-open-web/current` as an atomic symlink to one release. The `the-open-web` systemd service runs as `open-web` and reads `/etc/the-open-web.env`; the database lives under `/var/lib/the-open-web/`. Releases are root-owned and immutable to the service. Only application code is changed during a code release; the persistent database, service configuration, DNS, and Caddy configuration are preserved.

The live Caddy site serves `/opt/the-open-web/current/apps/web/dist` and proxies `/api/*` to `127.0.0.1:4323`. The checked-in Caddy template reflects that route. Validate the complete host Caddy configuration before changing site configuration, and reload Caddy only for a Caddy change. Do not copy a partial site file over the host configuration.

For an incident, inspect `systemctl status the-open-web`, `journalctl -u the-open-web`, the printed release ID and backup path, and the public health endpoint. Do not restore a database automatically during code rollback; a restore can discard writes made after the snapshot.
