# Adding a space

This is the implementation path for adding one finished space to the existing platform. It uses the real Astro, Fastify, SQLite, identity, realtime, rate-limit, test, and release infrastructure. Do not add an inactive entry or placeholder page just to reserve a name.

## 1. Register its public identity

Add one entry to `packages/shared/spaces.ts` when its route and experience are ready to be implemented:

```ts
{ id: 'example', label: 'Example', path: '/example', status: 'active' }
```

Use a stable lower-case ID made of words separated by hyphens. The ID becomes the API namespace and WebSocket channel. The path must be canonical, begin with `/`, and have no trailing slash. The registry is used by Astro and Fastify. Its automated test rejects duplicate IDs, duplicate or malformed routes, and active entries without a real page.

Registering an active entry without its server module makes the backend fail at startup. Keep only finished spaces active; the menu creates no placeholder links.

## 2. Create its frontend route and choose a layout

Create `apps/web/src/pages/example.astro` for `/example` (or a nested `index.astro` route). Use the shared layout so the GlobalMenu, document metadata, typography, focus styles, design tokens, and safe-area controls stay consistent:

```astro
---
import SpaceLayout from '../layouts/SpaceLayout.astro';
---
<SpaceLayout title="Example — The Open Web" layout="document">
  <main><!-- The space's own activity and controls --></main>
</SpaceLayout>
```

`document` is the default and allows normal page scrolling. Choose `layout="viewport"` only when the activity needs the full screen, as The Wall does. Put optional small utility controls in the named `utility` slot. Do not copy the global menu or shared shell into the page. If the space needs a distinct shell, import `GlobalMenu.astro` directly; it owns its fixed safe-area position and has fallback colors, so it does not depend on Wall layout rules. Keep the interaction model and content in the space's own frontend files, such as `apps/web/src/spaces/example/`.

The menu automatically includes the active registry entry and marks its route current. Check that the route behaves on keyboard, touch, narrow screens, safe areas, and both document and viewport layouts as appropriate.

## 3. Add the server module

Create `apps/server/src/spaces/example/index.ts` and export one `SpaceModule`. Register it explicitly in the `defaultModules` array in `apps/server/src/app.ts`, and import it there. Startup checks require exactly one module for every active registry entry.

Routes must remain under `/api/example/`. The platform checks every route registered by a module and rejects routes outside its namespace. The Wall's `/api/session` is a frozen compatibility route and must not be reused by another space; new functionality belongs under the space's namespace.

```ts
import type { SpaceModule } from '../types.js';

export const exampleSpace: SpaceModule = {
  id: 'example',
  register(app, context) {
    app.get('/api/example/state', async (request, reply) => {
      const visitor = context.identity.ensure(request, reply);
      // Read this space's snapshot for this visitor if needed.
      return { visitorDigest: visitor };
    });

    app.post('/api/example/action', async (request, reply) => {
      const visitor = context.identity.existing(request);
      if (!visitor) return reply.code(401).send({ error: 'session required' });
      // Parse and validate the space-specific body before any side effect.
      return { ok: true };
    });
  },
};
```

The example shows the module boundary; replace its placeholder response with the space's real behavior. `SpaceContext` provides:

- `db`: the one shared `DatabaseSync` connection. Keep queries and data-access functions in the space module directory.
- `config`: shared browser origin and secure-cookie setting.
- `identity`: `existing(request)` returns a digest or `null`; `ensure(request, reply)` issues the common cookie if needed and returns its digest; `clear(reply)` expires it.
- `realtime`: `publish(type, payload)` is bound to this module's registered space ID.
- `rateLimits`: factories for per-space token buckets and fixed windows.

Shared request hooks apply security headers, origin checks, the emergency write gate, trusted proxy handling, and global request bounds to every module route. Use non-safe HTTP methods for mutations. The body-size bound is 1 KiB. Validate all data according to the space's rules and return a small status-specific response, such as `400 {error: 'invalid input'}`, `401`, or `429`.

## 4. Use the anonymous visitor identity safely

All spaces share one first-party `ow_id` cookie. The platform extracts it centrally, stores only its SHA-256 digest for request handling, and removes the raw cookie from the request before the route reaches a module. Space code should use only `context.identity`; do not inspect cookies or headers for identity.

The digest is a pseudonymous bearer identifier, not proof of one human. Visitors can clear or change the cookie. Never place the cookie or digest in a URL, log, public event, or public profile. Store the digest only where the space needs it to implement a feature or abuse bound.

`GET /api/session` remains The Wall's compatibility endpoint and includes Wall cooldown fields. A new space can issue the shared cookie from one of its own routes with `identity.ensure`; it does not need to add another global session endpoint.

## 5. Add only the data the space needs

Put queries and transactions in `apps/server/src/spaces/example/database.ts`. Add the next consecutive, three-digit migration to `database/migrations`, named with the owner and purpose, for example `004_example_records.sql` after the current migration 003. Migration files already released are immutable. Do not add tables for planned but unbuilt spaces.

Prefix new tables and indexes with the space ID, use `STRICT` tables, explicit constraints and indexes for real query paths, and keep writes transactional. The database migration runner applies each new file in a transaction and records its version. A failed migration rolls back and prevents startup. The Wall's existing `wall_tiles` and `visitor_cooldowns` tables are legacy names and must not be renamed or rewritten by a new space.

The database is shared infrastructure, not a cross-space data API. Do not query or import another space's tables or functions. If behavior is truly common to multiple spaces, move only that reusable function into a shared module with a clear owner.

Backups use SQLite's online backup API so committed WAL data is included. Follow [BACKUPS.md](BACKUPS.md) for disposable restore testing and production recovery. Do not overwrite an active database or modify an already released migration to make a new schema change.

## 6. Add realtime only if the experience needs it

Clients connect to `/api/events?space=example`; the backend rejects missing, duplicated, inactive, and unknown subscriptions. Each connection stays on one channel. The module's `context.realtime.publish(type, payload)` adds the version-1 envelope and sends only to that channel. The payload must be a plain object, must not redefine `v`, `space`, or `type`, and the complete JSON event is limited to 1 KiB.

The space must validate its payload before publishing. Design the event type and payload in a short protocol note, then implement that space's initial snapshot and a race-safe reconciliation strategy. The shared server has no durable event log or replay. Decide how reconnect recovers state before relying on live events. See [REALTIME.md](REALTIME.md).

## 7. Pick an abuse limit that fits the activity

The shared platform always applies its global request caps, same-origin mutation check, proxy rules, secure headers, and emergency write gate. It also exposes bounded process-local primitives so each space can choose a policy:

- `context.rateLimits.tokenBucket({capacity, refillMs, maxEntries})` returns a limiter with `take(key, performance.now())`, `refund(key)`, and `prune(now)`. `take` returns `0` when allowed or a wait in milliseconds.
- `context.rateLimits.fixedWindow({limit, windowMs, maxEntries})` returns a limiter whose `take(key, Date.now())` result contains `allowed` and `retryAfterMs`.

Use only the key needed by the policy, such as the trusted network address or the derived visitor digest. These limits are in memory, reset on restart, and are not human identity. Keep a space's policy beside that module, and test its boundary and rejected-write behavior. Do not weaken the Wall's existing 12-action token-bucket burst, one token per second refill, or 10-second visitor cooldown.

## 8. Test the module and interaction

Add unit tests for validation, constraints, transactions, limit boundaries, module route ownership, identity use, and realtime isolation. The platform test suite uses in-memory fixture modules to verify registration without creating visitor-facing pages. Add browser checks for menu state, keyboard and touch operation, scroll behavior, and the space's own interaction. Keep stateful browser tests on their disposable test database.

Run the project's checks:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:production
npm run test:built
npm run test:load
npm audit
```

The load test uses a disposable local backend and must never target production. Update the architecture and protocol documentation with observed behavior, including snapshot and reconnect details.

## 9. Release the completed space

Review the complete diff, confirm that the Wall's routes, dimensions, palette, cooldown, overwrite behavior, and data remain unchanged, then commit and push the finished work. On the production host, run `npm run release -- --check-only` against the exact clean commit. It repeats dependency audit, lint, type checking, unit tests, production build, browser tests, production-only smoke test, isolated Caddy routing, the 500-client Wall load scenarios, and the mixed 400-Wall/100-Chat 500-connection check.

After that exact check passes, `npm run release` uses the guarded activation flow. It verifies host health and a fresh SQLite backup on the approved separate HDD before switching releases. It checks the new local and public health endpoints, release manifest, session response, and Wall page after restart. If the production host or required sudo access is unavailable, stop after verification and GitHub synchronization and report that deployment did not occur. See [DEPLOYMENT.md](DEPLOYMENT.md).
