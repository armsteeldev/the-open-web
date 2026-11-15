# The Open Web quality campaign

## Scope and guardrails

Improve the existing ten spaces and their shared frontend, backend, persistence, and operations without expanding the space count, changing user-created production data, or activating a release. Keep production inspection read-only. Preserve unrelated worktrees and historical migrations. Changes to public behavior or schema require explicit compatibility evidence.

## Baseline (2026-11-15)

- Checkout: clean `main` at `7c9664318f3fe290db3a0918d851e59d4d93c62e`, equal to `origin/main`.
- Preserved worktrees: `codex/bottle-rollback-bridge`, `codex/expansion-phase-i-rollback-bridge`, and `codex/final-expansion-rollback-bridge`; do not rewrite these branches.
- Production: public `/release.json` reports `54c6364646ecd4a424eb85dbe89aa689fc725036`; the host's `/opt/the-open-web/current` resolves to that same release. Service is active. Root redirects to `/wall/`; observed response headers include a self-only CSP, HSTS, no-referrer, `nosniff`, and frame denial. Candidate changes are not live.
- Repository inventory: 227 tracked files (252 files found across the inspected app/package/database/script/test/deploy/docs trees, including generated/cache and screenshot assets) across Astro frontend, Fastify server, shared packages, six append-only migrations, tests, and host-local guarded release tooling.
- Confirmed coverage gap: `npm run lint` targets server/shared/tests/scripts but omits `apps/web/src`. Verify the appropriate frontend checks before changing configuration.
- Existing docs include architecture, database, privacy, operations, backup, release, realtime, and design-principle notes; use these as contracts during review.
- Existing screenshots cover the spaces, including populated/empty Garden, Drawing Board, and Map states. Re-capture comparable states only where a change warrants it.

## Workstreams and status

| Workstream | Priority | Status | Evidence / next action |
| --- | --- | --- | --- |
| 1. Baseline verification and architecture audit | P1 | Complete | Lint/typecheck/80 unit tests, all Chromium suites, production smoke, built Caddy, isolated load, route assets, six SQLite plans, and cap-sized Questions timing recorded. |
| 2. Shared frontend, navigation, accessibility, and all ten spaces | P1/P2 | Implemented; browser pass | Frontend lint and Astro checks cover the previously omitted source; Questions protects drafts, request order, and focus. All 14 Chromium suites pass; accessibility, keyboard, touch, and viewport checks remain green. Seven unchanged spaces had no measured defect warranting code churn. |
| 3. Wall and Chat ordering/recovery | P1 | Reviewed; no protocol change justified | Existing fault tests cover stale snapshots, placement convergence, reconnect/history races, cooldown, and retries. The 500-client p95 is saturation-only; no Wall or Chat protocol code changed. Candidate latency was higher under 58.94% host CPU PSI and simultaneous external Chromium load, so this run is not a clean before/after comparison. |
| 4. Garden, Drawing Board, and Visitors Map | P1/P2 | Implemented; browser pass | Drawing paints new segments, splits long strokes at server bounds, preserves failed submissions, changes a conflicted retry key, and replays lost acknowledgements safely. Garden variation is deterministic, initial load has an in-page retry, and successful recovery clears the loading status. Map/Garden refresh errors distinguish a saved write from stale follow-up state. Desktop/mobile fault and touch regressions pass. |
| 5. Backend, SQLite, retention, identity, and abuse bounds | P1/P2 | Implemented locally | Migration 007 adds six cascade indexes, two Questions ordering indexes, and bounded anonymous-safe Drawing retry records. Forward/rollback checks pass. Five answer writes on a disposable 5,000-question/20,000-answer/20,000-retry-row database averaged 35.07 ms versus 65.80 ms baseline (46.7% lower); sample max was 41.93 ms. |
| 6. Release, backup, diagnostics, and recovery | P1/P2 | Bridge exact check passed and pushed | Existing online backup, restore, no-overwrite, release recovery, and health/process-identity tests are already strong; no extra daemon or dashboard is justified. The separate 004–007 bridge passed its exact guarded check and is pushed. Candidate release includes exact artifact and built three-engine checks. |
| 7. Second review and exact-candidate integration checks | P1 | Implemented and verified; final record commit gets one final gate | Reassessment found and fixed a stale Garden loading message and refreshed its evidence screenshot. Full checks and an exact guarded check-only release passed on `b3a979f97dd6164b34c8aeb0f4e240abef116de2`; because this record is changing the revision, rerun the same gate on the final documentation commit. Do not activate it. |

### Baseline checks so far

- `npm run lint`: pass (4.4 s), with the confirmed frontend omission above.
- `npm run typecheck`: pass (5.4 s); this does not establish `.astro` template/script diagnostics.
- `npm test`: 80/80 pass (19.1 s). Existing tests already cover migration failures, WAL crash recovery, retry/idempotency, privacy-safe logging, Wall concurrent overwrites, Story revision races, Garden occupancy, and deployment recovery.
- `npm audit`: 0 vulnerabilities at baseline (2026-11-15).
- Production `GET /api/health`: `{"ok":true}`. No writes or load were sent to production.
- Environment: Node `v22.23.4`, npm `10.9.9`, Chromium at `/snap/bin/chromium`.
- `npm run test:browser`: all 14 Chromium suites completed, including WCAG 2.1 A/AA axe checks at desktop/mobile, five menu/viewport sizes, Wall stale-snapshot and reconnect recovery, Chat history/event recovery, and all ten space routes. No failure was reported.
- `npm run build`: pass, 11 static routes in 612 ms. `npm run test:production` and `npm run test:built`: pass; the latter exercised the compiled app behind isolated HTTPS Caddy, CSP/Secure cookie/WSS, routing and spoofed-proxy rejection.
- Built Wall browser sample (Chromium emulation 1280×800): 48,781 transferred bytes across 9 requests, FCP 160 ms, JS heap 9.5 MiB, 4 initial tile requests (p95 6.32 ms), zoom-to-frame p95 0.2 ms and pan-to-frame p95 0.6 ms. This is a software/headless sample, not physical-device GPU performance.
- Per-route built assets include the shared menu JS and layout CSS. Exact raw/gzip bytes are recorded below; the map boundaries are 266,499 B raw / 89,579 B gzip.
- Isolated `npm run test:load`: at 500 Wall clients, 250,000 deliveries completed with placement p95 6,601.95 ms, broadcast p95 6,601.78 ms, backend RSS 114.3 MiB, and test DB 4.535 MiB. Mixed 400 Wall + 100 Chat clients delivered 160,000 Wall and 10,000 Chat events with zero cross-space delivery; Wall p95 4,820.08 ms, Chat p95 5,923.80 ms, broadcast p95 4,819.93 ms, RSS 121 MiB, DB 4.64 MiB. This intentionally saturates the isolated server at its 500-connection ceiling; it did not target production.
- SQLite `EXPLAIN QUERY PLAN` on a disposable migrated database confirms full scans for all six unindexed idempotency foreign-key child columns. The Questions per-question ranking uses a temporary B-tree for final sort terms; global answer-cap pruning scans and sorts the answer table.
- At the documented Questions maximum (5,000 questions, 20,000 answers and 20,000 retry rows), five isolated answer writes took 63.06–72.21 ms (65.80 ms average) with the current repeated cleanup and sorting.
- `npm run test:cross-browser`: pass in Chromium, Firefox, and WebKit against the built app behind isolated HTTPS Caddy; each engine loaded all ten routes at 1280×800 and 390×844, opened ten-space navigation, and had no horizontal overflow or page errors. Testing the Vite development server in Firefox produced a dev-tool `rolldown-runtime` import error; the built production path passed, so cross-engine checks use the built artifact.
- Frontend coverage gap confirmed and closed locally: `npm run lint` now includes `apps/web/src`; `npm run typecheck` runs both the existing root TypeScript check and `astro check --root apps/web` against 26 frontend source/template files. This exposed three Wall storage/parse catch blocks and one unused Map binding, which were fixed; the checker and lint now pass.
- Migration 007's candidate startup and forward/rollback simulation pass on disposable databases. Query-plan regression checks confirm all six cascade child lookups use their new indexes and both Questions answer-order queries avoid temporary sorting B-trees.
- A new independent compatibility-bridge test passes exact schemas 004, 005, 006, and 007 while confirming only Wall, Chat, and Bottle routes remain active. Its branch is pushed but has not been activated.
- At the same synthetic maximum collection size, five post-index Questions answer writes average 35.07 ms (range 30.12–41.93 ms), down from a 65.80 ms baseline average (63.06–72.21 ms). This is a small isolated sample, not a production latency guarantee; query plans independently confirm the intended sort work was removed.
- The baselined assets and checks were generated from the current clean `main` before application changes.

### Candidate checks so far (2026-11-15)

- `npm ci`: 428 packages installed; audit reported 0 vulnerabilities. `npm run lint` passed with the web source included.
- `npm run typecheck`: passed; Astro checked 26 files with 0 errors, 0 warnings, and 0 hints. `npm test`: 82/82 passed (27.4 s), including the new drawing retry, migration-plan, and rollback-gate coverage.
- Full `npm run test:browser`: all 14 Chromium suites passed, including axe WCAG 2.1 A/AA desktop/mobile/open-menu checks, keyboard and touch interactions, stale requests, failure recovery, and all ten routes. Final screenshots are saved in `docs/screenshots/quality-campaign/after/`.
- `npm run build`: passed; 11 static pages in 1.32 s. `npm run test:production`: all ten compiled-space smoke scenarios passed. `npm run test:built`: isolated HTTPS Caddy pass; 48,777 transferred bytes across 9 Wall requests, FCP 172 ms, JS heap 9.5 MiB, and 4 initial tiles. The 4-byte transfer reduction from baseline and sub-2 ms zoom/pan frame samples are not material wins; rendering behavior remained responsive in this headless run.
- `npm run test:cross-browser`: Chromium, Firefox, and WebKit each passed 20 built-route/viewport checks (10 routes × desktop/mobile), with navigation, no overflow, no page errors, and no external requests.
- Second review follow-up: `ONLY_BROWSER_TEST=final-spaces FINAL_SPACES_SCREENSHOT_DIR=docs/screenshots/quality-campaign/after npm run test:browser` passed all five final-space viewports and Garden/Drawing/Map interaction checks. It confirmed a successful initial Garden fetch clears “Opening the garden…”; corrected Garden screenshots show loaded controls and no stale status.
- Changed route bundles (raw/gzip bytes, baseline → candidate): Questions JS 7,014/2,511 → 7,479/2,704; Drawing Board JS 8,738/3,344 → 10,351/3,850; Garden JS 8,085/3,489 → 10,304/4,414; Map JS 5,678/2,732 → 5,918/2,827. The increases are concentrated in the features above; the Garden gains 925 gzip bytes for deterministic species/render variation. Wall transferred bytes remain effectively unchanged.
- The isolated answer-write benchmark used the same 5,000 questions / 20,000 answers / 20,000 retry rows and five-write method: baseline 65.80 ms mean (63.06–72.21), candidate 35.07 ms mean (30.12–41.93), a 46.7% lower mean. This is a small synthetic sample, not a production latency promise.
- Exact `npm run release -- --check-only` passed on `b3a979f97dd6164b34c8aeb0f4e240abef116de2`; it verified the commit and archive SHA-256 `3b5f3f6ffe22b63436d642caa982e5c6ed3188572801c3f3da0e30a49ef70966` without production changes. It includes install/audit, lint, typecheck, unit/integration, build, Chromium, compiled-production, built-Caddy, three-engine, and load checks.
- In that exact run, `test:load` passed connection-cap rejection and 0 cross-space deliveries. At 500 Wall clients p95 was 13,274 ms (250,000 deliveries; RSS 114.6 MiB, DB 4.535 MiB); mixed 400 Wall/100 Chat p95 was 10,142/11,891 ms respectively (160,000/10,000 events; RSS 120.5 MiB, DB 4.578 MiB). Baseline was 6,602 ms Wall-only and 4,820/5,924 ms mixed. Prior candidate and bridge runs varied under this 500-client saturation case; earlier measurement also recorded 58.94% CPU PSI `avg10`, load average 11.73, and unrelated Chromium workers using substantial CPU. No Wall/Chat protocol code changed, so this is inconclusive as a before/after comparison and is not typical visitor latency.
- Public state remains separate: `/release.json` still reports `54c6364646ecd4a424eb85dbe89aa689fc725036` and `/api/health` returns healthy. No public write, load, activation, or backup occurred.

| Route | JS raw / gzip (B) | CSS raw / gzip (B) |
| --- | ---: | ---: |
| Wall | 9,479 / 4,111 | 3,792 / 1,560 |
| Global Chat | 11,565 / 4,409 | 8,364 / 2,751 |
| Bottle | 5,321 / 2,294 | 6,138 / 2,192 |
| Guestbook | 3,646 / 1,697 | 5,920 / 2,099 |
| Story | 6,349 / 2,572 | 6,249 / 2,165 |
| Open Questions | 7,014 / 2,511 | 6,624 / 2,218 |
| The Choice | 7,413 / 2,772 | 7,473 / 2,467 |
| Drawing Board | 8,738 / 3,344 | 6,573 / 2,305 |
| Garden | 8,085 / 3,489 | 5,164 / 1,924 |
| Visitors Map | 5,678 / 2,732 | 5,324 / 1,986 |

## Confirmed findings and hypotheses

- Confirmed: frontend source was outside the configured ESLint target and Astro templates were unchecked. Candidate scripts now cover `apps/web/src` and run Astro diagnostics; exact release verification passed on `b3a979f97dd6164b34c8aeb0f4e240abef116de2`.
- Confirmed: production is behind current `main`; the candidate is not active. Any deployment discussion must retain this distinction.
- Confirmed and implemented: Drawing Board previously redrew the complete canvas on each coalesced pointer sample and let one stroke exceed its server cap. It now paints new segments, splits lines at 120 points without dropping join samples, enforces the 1,000-point/60-stroke limits, preserves drafts after failed uploads, and retries the same payload with one request key.
- Confirmed and implemented: Garden's dropdown could disagree with its canvas highlight; early taps could precede the initial state read; successful writes could mask failed follow-up reads; and a successful initial fetch left a stale loading message. Selection is now derived from the selector, controls report loading, saved-but-stale state has explicit recovery text, and successful recovery clears the loading status.
- Confirmed and implemented: Open Questions could overwrite an unsaved answer draft on selection, apply stale detail responses out of order, and leave keyboard focus in content hidden on mobile. It now guards request order, keeps session-local drafts, and returns focus to a visible heading.
- Confirmed by SQLite query-plan audit: six cascade-child idempotency foreign-key columns in migration 005 have no supporting index. Additive migration plus exact rollback compatibility is warranted; verify every cascade plan after migration.
- Confirmed and implemented locally: Drawing Board acknowledgement retries previously lacked a request key. Migration 007 adds a 24-hour UUID/payload-hash table without visitor identity; the database caps it through drawing ownership and deletes it on cascade.
- Confirmed and implemented locally: Garden could not retry its initial state read without reloading the page. It now exposes an in-page retry while leaving planting disabled until a valid server snapshot arrives.
- Confirmed by isolated saturation measurement: the existing 500-client all-to-all realtime check reaches 6.6 s p95 because each of 500 writes is delivered to 500 Wall sockets. Profile before changing the event contract; do not treat the saturation result as typical visitor latency.
- Confirmed: Questions answer cleanup performed repeated global sorting at its 20,000-row bound and made a synchronous write take about 66 ms on a representative maximum-size disposable database. The new indexes preserve retention behavior and reduce the measured average to about 35 ms; query plans no longer need a temporary sort B-tree.
- The existing backup drill is already a test: it copies committed WAL data, restores from the verified disposable copy, runs integrity checks, and proves an existing destination is not overwritten. Existing release recovery tests reject a false systemd-active claim when process identity, health, or manifest is wrong. These safeguards were retained rather than duplicated in a new operator tool.
- Remaining work: commit and push this final verification record, rerun `npm run release -- --check-only` on its exact SHA, verify origin hashes and public state, and report the final result. Production activation remains prohibited.
- Rejected: changing Wall/Chat fanout based solely on the 500-connection saturation benchmark, adding a monitoring service, altering retention rules, or introducing growth/plant ownership metadata. None had a measured benefit that justified protocol, privacy, or operational complexity.

## Checkpoints and decision log

Record each coherent change below with its commit, targeted tests, full-check status, and any before/after measurement. Reject speculative changes with a short reason. Keep deployment, push, and public activation as distinct states.

| Checkpoint | Result |
| --- | --- |
| Baseline | Complete for code, browser, build, production-smoke, assets, load, and query-plan checks. Chromium/Firefox/WebKit and cap-sized Questions timing are recorded. |
| Candidate implementation commits | `260231d` migration/index/retry behavior; `ea36523` Drawing, Garden, Questions, Map changes and screenshots; `2f62de2` frontend lint/Astro and three-engine gate; `c1c1fc1` Garden successful-load feedback fix and refreshed screenshots. |
| Rollback bridge commit | `51d028dc54637d8beb03180f56899c31bd6b4c02` on `codex/quality-campaign-rollback-bridge`; exact `release -- --check-only` passed (57/57 unit tests, Chromium, production smoke, built Caddy and load checks), then branch pushed. It has not been activated. Its isolated 500-client run completed 250,000 deliveries; p95 reached 14.37 s at the ceiling, confirming the test is a saturation check rather than normal-load latency. |
| Exact candidate check | `b3a979f97dd6164b34c8aeb0f4e240abef116de2` passed `npm run release -- --check-only`; archive SHA-256 `3b5f3f6ffe22b63436d642caa982e5c6ed3188572801c3f3da0e30a49ef70966`. This record's final commit is separately checked before delivery. |

## Finalization sequence

For release readiness, commit and push this final verification record, run `npm run release -- --check-only` on that exact SHA, verify origin hashes and public state, and report the result. Production activation remains prohibited.
