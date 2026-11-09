# The Open Web

A small, independent collection of shared spaces. The first is The Wall, a 2,000 × 2,000 collaborative pixel canvas. No accounts, analytics, advertising, ranking or tracking scripts.

## Develop

Requires Node 22.23.4–22.x and npm 9.6.5 or later. `npm ci`, `mkdir -p data`, then in separate terminals run `npm run dev:server` and `npm run dev:web`. Open http://localhost:4321/wall or http://127.0.0.1:4321/wall. The local database is in `data/`. See `.env.example`; environment variables must be exported to the server process. `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are the standard checks. `npm run test:browser` runs isolated desktop and mobile Chromium tests using disposable databases; install Playwright Chromium or set `CHROMIUM_PATH`. `npm run test:built` runs the compiled app over an isolated HTTPS Caddy instance and requires a production build, Caddy, OpenSSL and Chromium. `npm run test:production` checks the compiled backend with production-only dependencies in a temporary directory. `npm run test:load` starts an isolated compiled backend and tests up to 500 WebSocket clients and simultaneous placements on loopback, using a disposable database. Do not point the load test at a public or shared server. Astro's development tooling has its own optional telemetry; disable it with `npx astro telemetry disable`.

Keyboard users can focus the Wall, move the selection with arrow keys (Shift moves ten pixels), and place with Enter or Space.

See [architecture](docs/ARCHITECTURE.md), [design](docs/DESIGN-PRINCIPLES.md), [deployment](docs/DEPLOYMENT.md), and [operations](docs/OPERATIONS.md). This is not yet a verified production release; see deployment notes and test limitations.
