# Current findings

These payloads are routed from `LLM_README.md` at `7ab67cb0b6d843eca87f587124c0f3c0fbd35e67`; update their
status here so the root router stays stable.

<a id="router-landmines-heading"></a>
<!-- root-source:router.landmines.heading -->

## Landmines

<a id="router-landmines-001"></a>
<!-- root-source:router.landmines.001 -->

- **`columns` in `wbs-table.tsx` depends on `steps`, `unfoldedSteps`, `hiddenColumnIds` only**, each
  replaced only on the click that asked; anything else remounts every cell and eats the focus (`live` ref).
- **Row tints in `styles.css` go by predicate, not source order.** A new `data-*-lit` must join the
  banded-hover rule's `:not()` chain and never land on a row the pointer already hovers, or the rule
  is unmatchable and the stripe stops tinting. Negative must hover that row (`linked-row-hover`).
- `caddy reload` **exits 0 when it did nothing**. Verify against the admin API, never the exit
  code — `routedColorFromAdminConfig` parses the route and reads the tier's port. A substring
  test until 2026-08-04 matched `be-01-blue` inside `dev-be-01-blue` and read prod's colour wrong.
- `be-01.internal` resolves to **both colours** mid-swap (round-robin). Two releases, one DB file.
- `bun:sqlite` defaults to no WAL, `busy_timeout=0`. Set **and asserted at open** in
  `be-01/src/repository/db.ts`; an ESLint rule bans importing `bun:sqlite` elsewhere under
  `apps/be-01/src` — `busy_timeout`/`foreign_keys` are per-connection and a direct `new Database()`,
  or a reach into drizzle's `$client`, silently loses them. `boot.ts` goes through `openConnection`.
- **`ALTER TABLE … RENAME` rewrites other tables' `REFERENCES` only with `foreign_keys` on** — off
  for a whole fresh-DB run until `pendingNeedingForeignKeysOff`; a name sweep passed, five FKs dangling.
- **Migrations must be backward-compatible** — blue and green share one DB. `--stop-the-world`
  refuses. The lint catches the obvious destructive statements; the judgement is yours, asserted by
  `--with-migrations`. One waived rename (`WAIVERS`), gated on `bin/assert-no-prod-release.sh`.
- **`bun run e2e` reuses whatever holds 3100/3200/4200** (`reuseExistingServer: !isCi`) — 66 tests
  green against another checkout, 2026-08-09; it keeps its own `DB_PATH`. Shift onto ports the
  **browser** talks to: 1800 puts fe-01 on 6000 (`ERR_UNSAFE_PORT`); 1900 is good.
- **A whole-workspace run is not the sum of per-project runs** — six import-sort errors reached
  `main` on 2026-08-30 green in every per-project run. Gate before merging.
- **Playwright's `toHaveCount(0)` retries** — it passes the moment the count reaches zero, however
  late, so a _temporary_ absence needs `expect(await l.count()).toBe(0)` instead.
- `.dockerignore` is **not recursive**: `**/*.db`, not `*.db`.
- Server umask is `0002` — mode at birth, never chmod after (`configure.sh` does not; see findings).
- `--platform linux/amd64` is pinned **on the Dagger publish path**, which is the only supported one.
  A hand-run `docker build` from the Dockerfiles is not pinned. Dev is arm64, server is amd64.

<a id="router-findings-heading"></a>
<!-- root-source:router.findings.heading -->

## Open findings

<a id="router-findings-001"></a>
<!-- root-source:router.findings.001 -->

Both are **prod-phase** (Dany, 2026-08-06): recorded, not pending. Work stops at dev.

<a id="router-findings-002"></a>
<!-- root-source:router.findings.002 -->

1. Rollback unimplemented — `--version` is _refused_, so an older commit means a rebuild.
2. `configure.sh`'s root phase never run on a fresh host; only the plan is tested.

<a id="router-findings-003"></a>
<!-- root-source:router.findings.003 -->

3–5 closed, and so is 2026-09-09's "folded card under a pinned cell": a misread hit test, not a
fault. Lower: fe/smoke health takes any body; the WS ping any message with `"pong"`; drain reads
a bad metrics body as zero sockets; `tool-secrets` only prints. Cannot-fail: **27** (R5).
