# The Open Web

A small, independent collection of shared spaces: The Wall, a 2,000 × 2,000 collaborative pixel canvas, and Global Chat, one public realtime text room. No accounts, analytics, advertising, ranking or tracking scripts.

## Develop

Requires Node 22.23.4–22.x and npm 9.6.5 or later. `npm ci`, `mkdir -p data`, then in separate terminals run `npm run dev:server` and `npm run dev:web`. Open http://localhost:4321/wall or http://localhost:4321/chat. The local database is in `data/`. See `.env.example`; environment variables must be exported to the server process. `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are the standard checks. `npm run test:browser` runs isolated desktop and mobile Chromium tests using disposable databases; install Playwright Chromium or set `CHROMIUM_PATH`. `npm run test:built` runs the compiled app over an isolated HTTPS Caddy instance and requires a production build, Caddy, OpenSSL and Chromium. `npm run test:production` checks the compiled backend with production-only dependencies in a temporary directory. `npm run test:load` starts an isolated compiled backend and tests up to 500 Wall WebSocket clients plus a 100-client Chat broadcast on loopback, using a disposable database. Do not point the load test at a public or shared server. Astro's development tooling has its own optional telemetry; disable it with `npx astro telemetry disable`.

Keyboard users can focus the Wall, move the selection with arrow keys (Shift moves ten pixels), and place with Enter or Space. In [Global Chat](/chat), visitors can read the recent conversation and send text with an optional nickname without registering. See [Global Chat operations and protocol](docs/GLOBAL-CHAT.md).

Production is deployed at [open.armsteel.dev](https://open.armsteel.dev). See [Adding a space](docs/ADDING-A-SPACE.md) for the practical implementation guide, [architecture](docs/ARCHITECTURE.md) for shared boundaries, and [deployment](docs/DEPLOYMENT.md) for release and recovery gates. Identity, realtime, database, design, and operational conventions are documented under `docs/`.
