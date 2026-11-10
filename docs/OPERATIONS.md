# Operations

## Process and health

The service is one Node.js 22 Fastify process behind Caddy. It listens on loopback; do not expose that port publicly. `GET /api/health` checks migration metadata on each request and runs SQLite `quick_check(1)` at most once every 30 seconds. It does not prove that writes are enabled or that every space-specific operation is healthy.

Use `systemctl status the-open-web`, `journalctl -u the-open-web`, the public release manifest, and an HTTPS request through Caddy when checking a deployed release. On SIGTERM or SIGINT, the process closes WebSockets and the SQLite connection. There is no per-space systemd service.

At startup, the backend validates the active space registry against the explicit module list. A missing, duplicate, inactive, or unknown module fails closed. Each module's routes are checked against its `/api/{id}` namespace. Realtime subscriptions are accepted only for spaces with active modules.

## Shared protections

All routes receive security headers and a 1 KiB request body bound. Unsafe HTTP methods require an allowed origin and are rejected when `WRITES_ENABLED=false` or the emergency gate file exists. The origin must exactly match `ORIGIN`, with the existing localhost/127.0.0.1 development allowance. Forwarded client addresses are trusted only from the loopback Caddy peer.

Bounded process-local fixed-window guards cap requests at 600 per network address per minute and POST/session requests at 180 per minute. The Wall adds its existing 12-placement token-bucket burst with one token refilled each second, a 10,000-entry memory bound, and a 10-second per-cookie-digest cooldown. Other spaces should select and test a policy using their scoped token-bucket or fixed-window factory. Do not change Wall's current production limits as part of another space's work.

The shared WebSocket endpoint accepts at most 500 total connections and 10 per trusted network address. Realtime messages are limited to 1 KiB, slow buffered sockets are terminated at 64 KiB, and heartbeats remove dead connections. Realtime and abuse-limit state are local to this process and reset on restart. Distributed flooding still requires infrastructure-level controls.

Network addresses and rate counters live only in bounded memory and are not written to SQLite. Server request logging is disabled. The Caddy template does not enable access logs; review privacy, fields, and retention before enabling them.

## Emergency write stop

Preconfigure `WRITE_GATE_PATH` as an absolute path in an operator-controlled directory readable by the service. Creating that file blocks unsafe methods on the next request without a restart. A missing or unreadable parent directory also blocks writes. Removing the configured flag re-enables writes. Do not make its directory writable by untrusted users. The alternative is `WRITES_ENABLED=false` followed by a restart of only `the-open-web`.

The shared hook runs before every space route, so the emergency gate applies across all active modules. WebSocket clients cannot submit messages; they are disconnected if they send one.

## Configuration

- `PORT`: listener port, default `4322`.
- `DB_PATH`: SQLite file, default `./data/open-web.sqlite`; its parent directory must exist.
- `ORIGIN`: exact browser origin, default `http://localhost:4321`.
- `WRITES_ENABLED`: `true` or `false`, default `true`.
- `COOKIE_SECURE`: `true` or `false`, default `false`; HTTPS origins require `true`.
- `WRITE_GATE_PATH`: optional absolute emergency-gate path.
- `COOLDOWN_MS`: Wall compatibility setting; if set, it must equal the fixed `10,000` ms.

Invalid ports, booleans, origins, or gate paths prevent startup. Environment changes require a restart; creating or removing the gate file does not. For production backups and restoration, follow [BACKUPS.md](BACKUPS.md). For a release, use the guarded process in [DEPLOYMENT.md](DEPLOYMENT.md); it runs the full verification and requires a verified separate-HDD backup before activation.
