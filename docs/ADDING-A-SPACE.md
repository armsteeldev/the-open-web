# Adding a space

1. Add its definition to `spaces` in `packages/shared/spaces.ts` only when functional.
2. Create an Astro route using `SpaceLayout` for the shared menu, and an isolated client directory under `apps/web/src/spaces/`; reuse the small visual conventions from the Wall without imposing its canvas layout.
3. Add a server module and routes under `apps/server/src`, register them in `createApp`, and validate every input. Mutations must use non-GET methods so the shared origin check and emergency write gate apply. Add a numbered migration with independent tables and data-access functions. Use the next consecutive migration number; the runner applies it transactionally.
4. Use the session identity where needed; never expose its cookie. Namespace versioned WebSocket messages by `space`, define the snapshot and reconnect procedure, and subscribe only to appropriate events. Subscribe to `/api/events?space=<registered-id>` and pass the shared `SpaceChannels` instance into the new server module and publish through its `broadcast` method. Each new space must define snapshot and reconciliation behavior; the server only publishes Wall events today.
5. Add tests, document the protocol, and check mobile and keyboard use before exposing it.
