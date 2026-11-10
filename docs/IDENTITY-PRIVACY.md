# Identity and privacy

There are no accounts, registration, passwords, email addresses, mandatory usernames, public profiles, tracking IDs, or fingerprints. A visitor can participate anonymously.

## Shared anonymous visitor ID

The platform issues one first-party `ow_id` cookie for every space. It contains 256 random bits and is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and valid for one year. Production sets `Secure`; development follows the configured secure-cookie setting. `context.identity.clear(reply)` expires it with the same security attributes.

The platform cookie hook reads and validates the cookie, derives a SHA-256 digest for the request, then removes the raw cookie from parsed request cookies and the Cookie header before a space route runs. Modules receive only `existing(request)` and `ensure(request, reply)` methods. Space code must not read, copy, log, broadcast, or persist the secret cookie. The identity service does not expose the raw value.

A digest is a pseudonymous bearer identifier, not proof that a cookie represents one human. People may clear cookies, change browsers, share a device, or use multiple devices. A cookie can be copied or replaced. Do not describe the identity as verified, unique, permanent, or an account. A space should store the digest only when its feature or technical abuse bound requires it.

The Wall's existing `/api/session` route issues the cookie when needed and preserves its response fields `retryAt` and `retryAfterMs` for its cooldown UI. That endpoint is Wall compatibility behavior, not a requirement for new spaces. Other modules can call `context.identity.ensure` from their own route.

## Data and limits

The Wall stores only the digest and last placement time in `visitor_cooldowns`; migration 002 indexes the timestamp, and expired digests are removed in bounded batches. Neither Wall table stores an IP address. No other space should store data just because a digest is available.

Shared per-network request guards cap total requests at 600 per minute and POST/session requests at 180 per minute. The Wall also uses a process-local token bucket with a 12-placement burst and one token refilled per second, plus a 10-second visitor cooldown. Each future space chooses its own action policy with the shared bounded token-bucket or fixed-window primitive. Limits reset after process restart and cannot prevent distributed abuse.

IP-based limits use Fastify's trusted proxy configuration and live only in bounded process memory. Addresses are not written to the database. The server disables request logging; do not enable reverse-proxy access logging or extend retention without deciding what it records and for how long. No analytics or third-party scripts are used.
