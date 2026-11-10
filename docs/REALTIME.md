# Realtime protocol

## Shared connection contract

Clients connect to `GET /api/events?space=<registered-id>` and upgrade a same-origin request to WebSocket. The backend accepts only a currently active space with a registered server module. Missing, duplicated, inactive, and unknown IDs are rejected with policy close code 1008. A connection belongs to exactly one space for its lifetime. Client messages are not accepted.

The server sends JSON version-1 envelopes in this form:

```json
{"v":1,"space":"wall","type":"pixel","x":4,"y":5,"color":2}
```

The shared envelope fields are `v`, `space`, and `type`; remaining top-level fields are the space-owned payload. The owning space validates its event data before publishing. A module receives a publisher already bound to its space, so it supplies only the type and payload. It cannot select another channel through the shared publisher. The manager rejects reserved envelope fields, malformed event types, unknown channels, and serialized server events larger than 1 KiB.

The WebSocket server accepts payloads up to 1 KiB, but client messages are closed by the route handler. The service caps total connections at 500 and connections per trusted network address at 10. Buffered output at or above 64 KiB causes termination. Heartbeats terminate unresponsive peers, and closed or unusable sockets are removed from the channel registry.

## The Wall protocol

`GET /api/wall/tile/:x/:y` returns a row-major tile of 10,000 palette indices. `POST /api/wall/pixel` accepts JSON `{x,y,color}` and requires the shared cookie. A successful write commits the tile and cooldown before publishing the unchanged event `{v:1,space:"wall",type:"pixel",x,y,color}`. The response is `{ok:true,retryAt,retryAfterMs}`; a 429 may include the same timing fields. `retryAt` is epoch milliseconds and `retryAfterMs` is the remaining duration when the response is made.

The browser subscribes only to `wall`, loads visible tiles, and reconnects with exponential backoff and jitter capped at 30 seconds. It reloads visible snapshots on reconnect and invalidates a snapshot if a broadcast races with a tile fetch.

## Snapshot and reconnect belong to each space

There is no durable event log, replay, shared snapshot format, or cross-process broadcast. A new space must specify its initial snapshot, event ordering assumptions, and race-free reconciliation after reconnect. For example, a document editor and a chat history will need different recovery rules. Do not treat a WebSocket open event as proof that the client has current state.

The platform uses one Node.js process. Realtime messages are ephemeral and in-memory. Do not add a broker or external service without a separate architecture decision.
