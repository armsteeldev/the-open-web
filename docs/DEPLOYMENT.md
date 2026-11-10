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

The command stops before touching production if the checkout is dirty, required tools are missing, memory pressure is high, a check fails, the service is unhealthy, or the backup destination is not safe. Chromium is detected automatically; set `CHROMIUM_PATH` only if it is installed in a nonstandard location.

To choose a different approved backup directory:

```sh
npm run release -- --backup-dir /absolute/path/to/private-backup-directory
```

The default is `/mnt/continental-cloud/backups/the-open-web`. The activation step checks that the directory exists, is root-owned and private, has enough free space, and is on a different mounted device from the live database. It verifies the SQLite online backup before changing the active release.

## What activation checks

The privileged activation helper reads `PORT` and `DB_PATH` from the running service, checks local and public health before deployment, installs only production dependencies into a staged release, and runs the compiled production smoke test against a disposable database. It makes the release readable to the service and Caddy, then removes write permission. It backs up the active SQLite database, atomically switches `/opt/the-open-web/current`, and restarts only `the-open-web`.

Readiness checks poll for up to 60 seconds after restart. They require a healthy local and public API, a public release manifest that matches the full commit ID, a numeric cooldown duration from the session API, and the expected wall controls in the public page. If activation fails after switching, the helper restores the prior symlink, restarts the prior release, and checks health again. It retains the verified backup. Deployment and rollback share a lock so they cannot run at the same time.

The exact production hostname is `https://open.armsteel.dev`; Caddy forwards API requests to loopback port `4323`. The activation script reads the actual configured port and database path from the running service rather than assuming either value. Application-only releases do not reload Caddy.

## Code rollback

The activation helper records the previous immutable release. To switch back to it:

```sh
npm run rollback
```

This asks for sudo, atomically changes `current`, restarts only the app, and checks health. If the rollback release fails readiness, it restores the release that was active before the rollback. Code rollback does not restore or replace the database. Schema changes must remain compatible with the preceding release; restoring a database is a separate recovery decision described in [BACKUPS.md](BACKUPS.md).

## Current production record

As verified on 2026-11-10, production runs commit `5c7fc8458aa1edbdc512691d9553cf8f2f197b56` from `/opt/the-open-web/releases/5c7fc8458aa1edbdc512691d9553cf8f2f197b56`. The service uses `/var/lib/the-open-web/open-web.sqlite` and port `4323`. The verified pre-release database backup is `/mnt/continental-cloud/backups/the-open-web/open-web-before-5c7fc84.sqlite`, on the separate HDD mounted at `/mnt/continental-cloud`.

This checkout deploys locally to the host where the command runs. It does not push to a remote repository or depend on CI. Release evidence is the full commit ID printed by the command and its public manifest after activation. Keep the release and rollback commands on the same host as the production service.

## Host configuration contract

The production layout is `/opt/the-open-web/releases/<full-commit>/`, with `/opt/the-open-web/current` as an atomic symlink to one release. The `the-open-web` systemd service runs as `open-web` and reads `/etc/the-open-web.env`; the database lives under `/var/lib/the-open-web/`. Releases are root-owned and immutable to the service. Only application code is changed during a code release; the persistent database, service configuration, DNS, and Caddy configuration are preserved.

The live Caddy site serves `/opt/the-open-web/current/apps/web/dist` and proxies `/api/*` to `127.0.0.1:4323`. The checked-in Caddy template reflects that route. Validate the complete host Caddy configuration before changing site configuration, and reload Caddy only for a Caddy change. Do not copy a partial site file over the host configuration.

For an incident, inspect `systemctl status the-open-web`, `journalctl -u the-open-web`, the printed release ID and backup path, and the public health endpoint. Do not restore a database automatically during code rollback; a restore can discard writes made after the snapshot.
