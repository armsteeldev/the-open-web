# The Open Web

A small collection of ten independent internet spaces:

1. [The Wall](/wall) — a shared pixel canvas.
2. [Global Chat](/chat) — one public text room.
3. [Message in a Bottle](/bottle) — short notes found at random.
4. [Guestbook](/guestbook) — a visitor ledger.
5. [The Story](/story) — one shared, chaptered narrative.
6. [Open Questions](/questions) — questions and individual answers.
7. [The Choice](/choice) — one shared decision at a time.
8. [The Drawing Board](/draw) — individual sketches left for strangers.
9. [The Garden](/garden) — plants that grow in a shared space.
10. [Visitors Map](/map) — countries people choose to mark.

The collection is complete at ten spaces. There are no accounts, rankings, analytics, or tracking scripts.

## Develop

Requires Node 22.23.4–22.x and npm 9.6.5 or later. Run npm ci, then start npm run dev:server and npm run dev:web in separate terminals. The local SQLite database is in data/; see .env.example for server configuration.

Standard checks are npm run lint, npm run typecheck, npm test, and npm run build. npm run test:browser uses isolated databases and Chromium across desktop, large desktop, tablet, narrow mobile, and mobile landscape. Set CHROMIUM_PATH if Chromium is installed in a nonstandard location. npm run test:built checks the compiled app over isolated HTTPS Caddy. npm run test:production checks the compiled backend with production-only dependencies, and npm run test:load runs isolated Wall and Chat connection scenarios. Never point tests or load checks at a public or shared server.

The Wall supports keyboard navigation and placement. The Drawing Board also supports keyboard drawing; Garden has an accessible plot selector; Visitors Map has a country selector as an alternative to map clicks.

Production runs at [open.armsteel.dev](https://open.armsteel.dev). See [the architecture](docs/ARCHITECTURE.md), [space details](docs/FINAL-SPACES.md), [database rules](docs/DATABASE.md), [privacy](docs/IDENTITY-PRIVACY.md), and [deployment and rollback](docs/DEPLOYMENT.md).
