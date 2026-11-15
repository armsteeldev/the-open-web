# Production deployment

## Release with one command

From the project checkout, commit the changes you intend to publish, then run:

```sh
npm run release
```

The command builds and checks the exact clean Git commit in a fresh temporary checkout. It runs dependency installation and audit, backend and frontend linting, TypeScript and Astro diagnostics, unit tests, production build, Chromium interaction checks, three-engine built-route checks, production dependency smoke test, isolated Caddy routing test, and the load check. The browser, built-app, production smoke, and accessibility checks cover all ten spaces. The final-spaces browser pass captures blank, active, populated, and mobile interactions in its disposable database across desktop, large desktop, tablet, narrow mobile, and mobile landscape. The load test retains the 500-client Wall scenarios and exercises 400 Wall plus 100 Chat WebSocket clients together at the shared 500-connection limit; the final three spaces add no WebSocket clients. It creates a checksummed package containing that build. Only after those steps pass does it request sudo for production activation. Enter the sudo password in the terminal when prompted.

Use the check-only form to run the complete verification and package the commit without changing production:

```sh
npm run release -- --check-only
```

The check-only command verifies and packages the commit without contacting the production service or changing production. The activation path in `npm run release` then checks host health, service configuration, backup-device separation, backup-directory ownership and permissions, available space, and the fresh SQLite backup before switching releases. Chromium is detected automatically; set `CHROMIUM_PATH` only if it is installed in a nonstandard location.

Migrations 005, 006, and 007 require a compatibility-first release sequence. The quality-campaign candidate refuses activation unless its rollback target can validate the exact 004–007 schemas. Deploy and verify the separate quality-campaign bridge first; it serves only The Wall, Global Chat, and Message in a Bottle, ships migrations only through 004, and recognizes only the exact later schemas. See [ROLLBACK-COMPATIBILITY.md](ROLLBACK-COMPATIBILITY.md) for the branch and guarded rollout order.

To choose a different approved backup directory:

```sh
npm run release -- --backup-dir /absolute/path/to/private-backup-directory
```

The default is `/mnt/continental-cloud/backups/the-open-web`. The activation step checks that the directory exists, is root-owned and private, has enough free space, and is on a different mounted device from the live database. It verifies the SQLite online backup before changing the active release.

## What activation checks

The privileged activation helper reads `PORT` and `DB_PATH` from the running service, checks local and public health before deployment, installs only production dependencies into a staged release, and runs the compiled production smoke test against a disposable database. It makes the release readable to the service and Caddy, then removes write permission. It backs up the active SQLite database, atomically switches `/opt/the-open-web/current`, and restarts only `the-open-web`.

Readiness checks poll for up to 60 seconds after restart. They require the service process working directory to match the selected immutable release, healthy local and public APIs, a public release manifest that matches the full commit ID, a numeric cooldown duration from the session API, the expected Wall controls, valid Chat and Bottle responses, all ten page surfaces and API snapshots, the bundled country-boundary data, and all ten navigation entries. If activation or manual rollback fails after switching, the helper restores the prior symlink and reports recovery only after systemd, the actual process directory, local/public health, and public manifest all match the restored release. It retains the verified backup. Deployment and rollback share a lock so they cannot run at the same time.

The exact production hostname is `https://open.armsteel.dev`; Caddy forwards API requests to loopback port `4323`. The activation script reads the actual configured port and database path from the running service rather than assuming either value. Application-only releases do not reload Caddy.

## Code rollback

The activation helper records the previous immutable release. To switch back to it:

```sh
npm run rollback
```

This asks for sudo, atomically changes `current`, restarts only the app, and verifies the selected process, health, and public manifest. If the rollback release fails readiness, it restores the release that was active before the rollback and verifies it before reporting recovery. Code rollback does not restore or replace the database. Schema changes must remain compatible with the preceding release; restoring a database is a separate recovery decision described in [BACKUPS.md](BACKUPS.md).

## Production baseline checked for the ten-space candidate

At the start of this assignment on 2026-11-15, the public release manifest reported commit `54c6364646ecd4a424eb85dbe89aa689fc725036`; public health was healthy. That release serves the established three spaces and contains migrations only through 004. Its live migration runner rejects version 005 and newer unless a compatibility release is installed, so a healthy process on that commit is evidence that the database remains on the 004-compatible schema. A direct read of the production migration table was not available during preparation; the database itself was not changed.

The earlier final-expansion bridge remains preserved, but cannot validate migration 007. A new quality-campaign bridge based on that branch validates 004–007 without applying later migrations and keeps the three established spaces active. The improved ten-space candidate and new bridge remain pending separate production approval. `npm run release -- --check-only` builds and packages the exact commit without contacting production, activating code, or creating a production backup.

## Host configuration contract

The production layout is `/opt/the-open-web/releases/<full-commit>/`, with `/opt/the-open-web/current` as an atomic symlink to one release. The `the-open-web` systemd service runs as `open-web` and reads `/etc/the-open-web.env`; the database lives under `/var/lib/the-open-web/`. Releases are root-owned and immutable to the service. Only application code is changed during a code release; the persistent database, service configuration, DNS, and Caddy configuration are preserved.

The live Caddy site serves `/opt/the-open-web/current/apps/web/dist` and proxies `/api/*` to `127.0.0.1:4323`. The checked-in Caddy template reflects that route. Validate the complete host Caddy configuration before changing site configuration, and reload Caddy only for a Caddy change. Do not copy a partial site file over the host configuration.

For an incident, inspect `systemctl status the-open-web`, `journalctl -u the-open-web`, the printed release ID and backup path, and the public health endpoint. Do not restore a database automatically during code rollback; a restore can discard writes made after the snapshot.
