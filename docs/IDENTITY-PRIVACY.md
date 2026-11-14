# Identity and privacy

There are no accounts, registration, passwords, email addresses, mandatory usernames, public profiles, analytics tracking IDs, or fingerprints. A visitor can participate anonymously.

## Shared anonymous visitor ID

The platform issues one first-party `ow_id` cookie for every space. It contains 256 random bits and is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and valid for one year. Production sets `Secure`; development follows the configured secure-cookie setting. `context.identity.clear(reply)` expires it with the same security attributes.

The platform cookie hook reads and validates the cookie, derives a SHA-256 digest for the request, then removes the raw cookie from parsed request cookies and the Cookie header before a space route runs. Modules receive only `existing(request)` and `ensure(request, reply)` methods. Space code must not read, copy, log, broadcast, or persist the secret cookie. The identity service does not expose the raw value.

A digest is a pseudonymous bearer identifier, not proof that a cookie represents one human. People may clear cookies, change browsers, share a device, or use multiple devices. A cookie can be copied or replaced. Do not describe the identity as verified, unique, permanent, or an account. A space should store the digest only when its feature or technical abuse bound requires it.

The Wall's existing `/api/session` route issues the cookie when needed and preserves its response fields `retryAt` and `retryAfterMs` for its cooldown UI. That endpoint is Wall compatibility behavior, not a requirement for new spaces. Other modules can call `context.identity.ensure` from their own route.

Global Chat derives a public display label from the existing digest with a chat-specific domain separator. It returns only a nine-digit decimal label; it never returns the cookie or internal digest. The label is stable while the cookie remains and is not guaranteed unique or verified. It is shown so visitors can follow a conversation, not for analytics or cross-site tracking. A custom nickname is an optional local preference and is shown beside the label; it grants no ownership and changing it affects only future messages. The label requires no additional database row, cookie, fingerprint, or personal data.

## Data and limits

Global Chat stores the shared cookie digest on each retained message to enforce its three-second per-visitor cooldown and stores a digest plus client request key in a separate idempotency table for up to one hour (capped at 10,000 entries). Chat message text and the selected display nickname remain in the recent-message table for at most 24 hours and no more than 2,000 messages. Removal tombstones contain only a message ID and removal time and are bounded to one day and 5,000 entries. No chat cookie, digest, or network address is sent to other visitors. The optional nickname is saved only in that browser's local storage.

The Wall stores only the digest and last placement time in `visitor_cooldowns`; migration 002 indexes the timestamp, and expired digests are removed in bounded batches. Neither Wall table stores an IP address. Message in a Bottle stores no digest beside a public message. Its short-lived `bottle_visitor_cooldowns` and 24-hour `bottle_idempotency` tables use the digest only for cooldown and retry control; both tables are capped at 10,000 rows, and neither value is returned to visitors. A bottle's optional signature is arbitrary self-declared text, not a verified identity. No other space should store data just because a digest is available.

Shared per-network request guards cap total requests at 600 per minute and POST/session requests at 180 per minute. The Wall also uses a process-local token bucket with a 12-placement burst and one token refilled per second, plus a 10-second visitor cooldown. Bottle uses a persisted 20-second per-cookie cooldown, a per-network bucket with a 20-release burst and one token every three seconds, and a global bucket with a 60-release burst and one token every second. Bottle discovery uses a 60-request burst per network and one token every second. Limits reset after process restart and cannot prevent distributed abuse.

Global Chat uses a persisted three-second per-cookie cooldown, a per-network token bucket with a 20-message burst and one token refilled every three seconds, a process-wide bucket with a 120-message burst and five-message-per-second refill, and a 30-second same-text repeat check per cookie. Chat and Bottle limits charge only accepted writes; rejected submissions refund process-local tokens. In-memory limits reset after restart and cannot prevent distributed abuse.

IP-based limits use Fastify's trusted proxy configuration and live only in bounded process memory. Addresses are not written to the database. The server disables request logging; do not enable reverse-proxy access logging or extend retention without deciding what it records and for how long. No analytics or third-party scripts are used.
