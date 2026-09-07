# Sweep F — operational tooling and test infrastructure

Read-only. `main` @ `3346bb15` (155 commits after the 2026-08-30 sustainability
audit). Nothing in the repo was modified. Every number below was measured this
session on this Mac unless it says otherwise; the audit's figures are quoted
only where they are being corrected.

Vocabulary: module / interface / implementation / seam / adapter / depth /
leverage / locality.

---

## 0 · Measured numbers (this session, this Mac)

| Measure                                     | Value                                         | Audit (2026-08-30)      | Command                        |
| ------------------------------------------- | --------------------------------------------- | ----------------------- | ------------------------------ |
| `libs/domain` tests                         | **145 in 0.29s**, 10 files                    | 128 / 0.2s              | `bun test` in `libs/domain`    |
| `apps/be-01` tests                          | **1,261 in 55.8s**, 91 files                  | 1,203 / 26.6s, 88 files | `bun test` in `apps/be-01`     |
| `eslint libs/domain/src` cold               | **5.31s**                                     | 12s                     | `bunx eslint`                  |
| `eslint libs/domain/src` warm `--cache`     | **1.26s** (write pass 3.20s)                  | —                       | cache in scratchpad            |
| `eslint apps/be-01/src` cold                | **14.69s**                                    | 41s                     | `bunx eslint`                  |
| `eslint apps/be-01/src` warm `--cache`      | **2.37s** (write pass 13.91s)                 | 2.5s                    | cache in scratchpad            |
| `nx format:check --all`                     | **18.91s**                                    | 44s                     | `bunx nx`                      |
| `prettier --check` direct                   | 17.66s (different file set — not a clean A/B) | 14s                     | —                              |
| `tsc --noEmit -p libs/domain/tsconfig.json` | **0.39s, 0 files loaded**                     | —                       | `--listFiles \| wc -l`         |
| e2e cases                                   | **229 in 24 specs**, `workers: 1`             | 18 specs                | `grep`, `playwright.config.ts` |
| fe-01 vitest                                | not run (minutes)                             | 1,897 / 185s            | —                              |

**The audit's lint numbers are ~3× stale on this hardware.** The ordering
survives (cache is a 6× win on be-01, 4× on domain), but "41s → 2.5s" is now
"14.7s → 2.4s". The `nx format:check --all` → direct-prettier claim (44s → 14s)
**does not reproduce**: 18.9s vs 17.7s, and the direct run scans a different
file set. That quick win is dead; do not spend the half hour on it.

**Survey counts, re-measured** (audit figure in parentheses):

| Count                                                            | Now                                    | Audit          |
| ---------------------------------------------------------------- | -------------------------------------- | -------------- |
| be-01 test files                                                 | 91                                     | 88             |
| …that hand-build `WorkItemService`                               | **24**                                 | 24             |
| …that use `buildServices()`                                      | **1** (`services.test.ts` only)        | 0              |
| …that repeat `mkdtemp + runMigrations + openDrizzle`             | **34**                                 | —              |
| …that repeat `mkdtemp + runMigrations` (any opener)              | **41**                                 | 41             |
| be-01 test files that open SQLite                                | **34 of 91**                           | 45 of 88       |
| `register()` copied in controller tests                          | **8 files** (7 be-01 + 1 mcp-01)       | 5              |
| `send()` copied                                                  | 1 (`capacity.controller.test.ts`)      | 4              |
| fe-01 test files                                                 | 64                                     | —              |
| …that build their own `ProjectApi`                               | **7** (+1 `DirectoryApi`)              | 6              |
| …ad-hoc `ProjectApi` literal sites in `wbs-table.test.tsx` alone | **29**                                 | —              |
| fe-01 `src/testing/`                                             | **does not exist**                     | does not exist |
| be-01 `src/testing/`                                             | **19 modules, 2,031 LOC, 0 open a DB** | 33 suites      |
| e2e specs / helpers                                              | **24 / 2**                             | 18 / 1         |
| `seedPlan` defined                                               | **7×**                                 | 6×             |
| `chooseTheme` defined                                            | **6×**                                 | 4×             |

---

## 1 · `tools/**` — file by file

`file | LOC | role | reuse | performance | readability/DDD`

### tool-remote-scripts (the server-side swap executor)

**`tools/tool-remote-scripts/src/swap.ts` | 1033 | the blue/green swap: thin IO
shell over `lib/`'s pure planners.**
_Reuse:_ the seams are real and named — `StartGreenDeps` (`:459`) and
`SwapRunDeps` (`:914`) are injected interfaces, and `swap.test.ts:343`/`:410`
drive them. But the shell has **three private IO helpers with no seam at all**:
`sh()` (`:100`), `containerIp()` (`:126`), `currentCaddyConfig()` (`:319`).
Everything in the 260-line `execute()` switch (`:508–860`) reaches `sh()`
directly, so the whole step machine — the part that carries the abort ordering —
is only reachable from a real `docker` binary. `pollActiveConnections` (`:168`)
is a re-implementation of `lib/health.ts`'s AbortController+setTimeout pattern
and says so in its own doc comment; `tool-smoke/src/health.ts:36` is a third
copy that also says so. Three copies, three comments admitting it.
_Performance:_ `BE_REVOKE_ALIAS_SETTLE_MS = 5_000` (`:228`) is a **fixed sleep
used as pacing** — documented as a bound rather than a drain, honestly, but it
is 5s on every `be` swap. `health-gate` (`:706`) polls 120 × 500ms = 60s
ceiling. Not a gate-wall-clock item; it is production latency.
_Readability/DDD:_ comment-to-code is roughly 2:1 and the comments are load-
bearing history, not restatement — this is the best-documented file in the repo.
The cost is locality: `execute()` is one function holding eleven step bodies and
a 120-line nested `abortSwap` closure (`:558–678`) that captures three pieces of
undo state (`aliasMovedToGreen`, `siteTextBefore`, `migrationBaseline`). The
undo ordering is the domain rule; it lives in a closure, so it can only be
tested through a real docker.

**`tools/tool-remote-scripts/src/lib/docker.ts` | 500 | pure command builders,
env allowlists, compose context.**
_Reuse:_ `IMAGE_NAME` (`:32`) is a byte-identical duplicate of
`tool-dagger/src/lib/publish.ts:3`. `type Tier` is declared **three times**:
`lib/state.ts:1`, `tool-dagger/src/lib/publish.ts:1`, `tool-deploy/src/affected.ts:3`.
`PORT` (`:65`) is duplicated at `tool-deploy/src/deploy.ts:335` and
`tool-smoke/src/health.ts:71`, each with a comment claiming no `@wbs/*` entry
point exists — **that claim is false**, see §4.
_Performance:_ none — pure.
_Readability/DDD:_ the best module here. `grantAliasCommands`/`revokeAliasCommands`
(`:460`,`:469`) carry the round-robin-DNS finding in a 60-line doc comment that
is the only written record of it. `assertDigestPinnedRef` (`:94`) and
`deriveTierSecrets` (`:169`) are proper domain functions.

**`lib/env.ts` | 123 | THE environment seam.** _Reuse:_ the model for the rest of
the repo — one `LAYOUTS` table, one `process.env['WBS_ENV']` read (`:123`), and
`lib/env-seam.test.ts` asserts by source scan that there is no second reader.
_Performance:_ none. _Readability:_ exemplary. **One gap:** `env-seam.test.ts:21`
scopes its scan to `tools/tool-remote-scripts/src` only. A second `WBS_ENV`
reader in `tool-deploy` or `tool-dagger` would not be caught. (Grepped: none
today.)

**`lib/reconcile.ts` | 70 | `planSwap` — pure planner.** none / none / clean.
**`lib/state.ts` | 44 | `Tier`/`Color`/state JSON.** duplicate `Tier` (above) / none / clean.
**`lib/lock.ts` | 128 | `flock`-based deploy lock.** none / none / clean.
**`lib/site.ts` | 206 | `site.caddy` route blocks, `routedColorFromAdminConfig`.**
`DEV_MCP_ROUTES` (`:5`) is a 24-line Caddy literal embedded in TS that
`deploy/compose/site-dev.caddy.candidate` (60 LOC) also holds — two spellings of
one vhost, only one of which is rendered. / none / clean.
**`lib/atomic.ts` 53, `lib/health.ts` 37, `lib/drain.ts` 17, `lib/phase.ts` 14** —
small, sharp, injected. none / none / clean.
**`lib/caddy.ts` | 12 | `assembleCaddyfile`.** **Dead.** Its only caller is
`swap.test.ts:43`. Deletion test: passes (delete file + that describe block).

**`tools/tool-remote-scripts/src/install.ts` | 191 | ships `swap.js`/`smoke.js`.**
_Reuse:_ `parseSha256sumOutput` (`:95`) and `sha256File` (`:89`) are **verbatim
duplicates** of `tool-deploy/src/deploy.ts:411`/`:405`, comment included.
`BUNDLE_FILES` (`:55`) is duplicated at `deploy.ts:396`.
_Performance:_ none.
_Readability:_ **a real defect, not just duplication.** `install.ts` has no
`--env` flag; its `BUNDLE_FILES` resolve against `ROOT = CURRENT_ENV.root`, i.e.
the operator's ambient `WBS_ENV`. `deploy.ts` resolves against `args.layout.root`
from `--env=`. So `deploy.ts:461`'s own error message — _"Run `nx run
tool-remote-scripts:install --host=… --execute` first"_ — is **wrong for a dev
deploy**: that command installs into prod's `/home/puni1/wbs/bin` unless the
operator independently knows to export `WBS_ENV=dev`. The two halves of one
contract disagree about which environment they are in.

### tool-deploy (the orchestrator)

**`tools/tool-deploy/src/deploy.ts` | 566 | plan + execute a deploy.**
_Reuse:_ imports `@wbs/tool-env` on line 9 — and then at line 330 says _"that
project has no `@wbs/_`public entry point"* to justify duplicating`TIER_APP`,
`TIER_HEALTH_PORT`, `TIER_HEALTH_PATH`, `BUNDLE_FILES`, `sha256File`and`parseSha256sumOutput`. The comment is stale in the file that disproves it.
`defaultDirtyPaths()` (`:85`) + `assertCleanWorktree()` (`:120`) is the same
`git status --porcelain`gate as`tool-dagger/src/main.ts:assertCleanTree()`
(`:~460`), with two different messages and two different shapes (paths vs
string).
_Performance:_ `assertBundleInstalled` (`:432`) does one `ssh` round trip for
both files — good. The deploy is sequential per tier, deliberately (`:~540`).
_Readability/DDD:_ `buildDeployPlan` (`:158`) is a pure planner over an injected
`DeployPlanDeps` — the right shape. Its migration gate (`:200–250`) is the
sharpest domain rule in the tool tree.

**`src/affected.ts` | 97 | arg parsing + tier materialisation.** duplicate `Tier`
/ none / clean; the rejected-flag arm (`:70`) is a model R5 refusal.
**`src/remote-state.ts` | 125 | remote state read + fail-closed parser.** none /
one ssh round trip / clean.
**`src/migrations.ts` | 74 | the migration gate.** none / `git ls-tree` per sha /
clean; pure comparison split from git plumbing, as R3 asks.
**`src/ssh.ts` | 12 | `buildSshInvocation`/`buildScpInvocation`.** **Dead, and a
duplicate of dead code.** Only caller is `deploy.test.ts:97`. `libs/scripts/src/ssh.ts`
holds `buildSshCommand`/`buildScpCommand` — same idea, richer (port, identity
file), also called only by its own test (`libs/scripts/src/shell.test.ts:5`).
Two unused SSH command builders, 39 LOC, each with a test proving it still
formats a string nothing sends. Deletion test: both pass.

### tool-dagger (build + publish)

**`tools/tool-dagger/src/main.ts` | 540 | capacity admission, engine lifecycle,
Dagger publish.**
_Reuse:_ `assertCleanTree()` duplicates `tool-deploy`'s worktree gate (above).
_Performance:_ `assertBuildCapacity` (`:105`) is the guard that keeps a release
build from taking prod down — 8 GiB free, tmpfs < 25%, load1 ≤ cpus. Correct and
fail-closed. `runEngineLifecycle` (`:~270`) installs SIGINT/SIGTERM handlers and
stops the engine outside the work callback; the `AggregateError` merge is right.
_Readability/DDD:_ `assertEngineContract` (`:160–235`) is 75 lines of hand-rolled
`unknown`-narrowing against a Docker inspect document. This is exactly what
ArkType is already a dependency for; the repo validates HTTP bodies with a
schema library and validates the container that builds production with `if`s.

**`src/be-01.ts` | 46, `src/gw-01.ts` | 46, `src/fe-01.ts` | 45 | vestigial.**
_Reuse:_ the three differ only in a tier letter — I diffed them; `be` vs `gw` is
7 changed lines, `be` vs `fe` is 8. They compute a `.tar.gz` bundle name and a
META.json for a **tarball release format that no longer exists**, then print
_"this per-tier script only computes a bundle plan. Real Docker
builds/publishes now run through `nx run tool-dagger:publish-all`."_
_Performance:_ **worse than dead — they are wired into the gate.**
`tool-dagger/project.json` declares `build-be`/`build-gw`/`build-fe` with
`outputs: ["{workspaceRoot}/dist/tool-dagger/release-be"]` (etc.) which these
scripts never write, and `publish-be` `dependsOn` them. Nx caches three targets
whose declared output never appears.
_Readability/DDD:_ `lib/image.ts` (27) and `lib/bundle.ts` (16) exist only to
serve these three. `lib/image.ts`'s `DEFAULT_IMAGES` names `oven/bun:1.2-debian`
and entrypoints that **contradict the real Dockerfiles** — a second, wrong
source of truth for what the images are. Deletion test: delete `be-01.ts`,
`gw-01.ts`, `fe-01.ts`, `lib/image.ts`, `lib/bundle.ts`, `dagger.test.ts` (40
LOC) and the six `build-*`/`publish-*` targets' `dependsOn`; nothing production
loses anything. **~220 LOC + 3 Nx targets.**

**`src/lib/publish.ts` | 71 | `imageRef`/`digestRef`/`parseDigest`/`ReleaseEntry`.**
duplicate `Tier` + `IMAGE_NAME` / none / clean; the `ReleaseEntry.image` doc
comment is the canonical record of the two-`REGISTRY`-defaults defect.

### tool-smoke

**`src/ws-ping.ts` | 466 | WS ping + backend-hop probe, over a hand-rolled RFC
6455 client.**
_Reuse:_ `encodeTextFrame`/`consumeFrame` (`:~300`) are a private mini-WebSocket;
justified in a 40-line comment (Bun's `WebSocket` cannot set TLS SNI, verified).
`runPingSmoke` and `runBackendHopSmoke` share a `finish`/`settled`/`timer`
skeleton — two copies of the same settle-once promise shape.
_Performance:_ `FORWARD_DRAIN_MS = 500` (`:~110`) is a **fixed sleep as pacing**,
documented as bounding a race it cannot close.
_Readability/DDD:_ the "Proof:" lines (`:~50`, `:~175`, `:~185`, `:~195`) name
the exact mutation that makes each branch fail — this is R5 done properly and is
the best pattern in the repo for an agent to copy.
**Stale landmine:** `LLM_README.md` still says _"the WS ping passes on any first
message containing `\"pong\"`"_. It does not — `runPingSmoke` JSON-parses and
matches `frame.type === 'pong'`, and refuses non-JSON. The landmine list is
lying about a fixed defect.

**`src/health.ts` | 242 | HTTP health suite.** third copy of the
fetch-with-deadline pattern (`:36`, comment admits it) and a fourth copy of
`PORT`/health paths (`:71`) / none / clean.
**`src/main.ts` | 57 | bundle entry.** none / none / clean; the `runSuite`
try/catch (`:~35`) is the reason a thrown guard cannot hide the other suite.
**`src/color.ts` | 18 | `resolveColor`.** _Dead in the deploy path._ `deploy.ts`'s
`buildSmokeCommand` (`:~360`) supplies per-tier `SMOKE_*_URL` overrides
precisely because a single `SMOKE_COLOR` is wrong; `tool-smoke/project.json`'s
`smoke` target still passes `-e SMOKE_COLOR`. Two contradictory colour models,
one of them unreachable from `tool-deploy`.

### the rest

**`tools/tool-compose/src/render.ts` | 98 + `index.ts` | 16 | template rendering,
and the one project with a real public entry point.** `index.ts` is the model
the other three tool projects' "no entry point exists" comments should have
followed. / none / clean.
**`tools/tool-bootstrap/src/push.ts` | 266 | five-step host provisioning.** none /
none / clean; the secret-over-stdin design (`:~25`) is correct and the
`envKeys`-not-values plan shape makes it testable without a secret.
**`tools/tool-bootstrap/src/lib/secrets.ts` | 30.** none / none / clean.
**`tools/tool-devsync/src/sync.ts` | 199 | the dev deploy.** `RESTART_PATHS`
(`:39`) and `RECREATE_PATHS` (`:85`) are data, and `sync.test.ts` fails if a lib
on disk is missing from the list — a self-maintaining check. `hashPath` shells
out to `find|sort|xargs sha256sum|sha256sum` per path, `Promise.all`-ed. /
`needsRestart` fail-closed on missing evidence — right. / clean.
**`tools/tool-git-hooks/src/hooks/plaintext-secrets.ts` | 97.** `UnscannableFileError`
(`:17`) is the cleanest R5 artefact in the repo: unreadable ≠ clean. none / none /
clean.
**`hooks/migration-lint.ts` | 247 | forbidden statements + `down.sql` presence +
one dated waiver.** none / none / clean.
**`hooks/doc-caps.ts` | 61.** caps as data (`:12`) / none / clean.
**`hooks/conventional.ts` | 29.** **Dead** — `lefthook.yml:24` has the
`commit-msg` block commented out. Kept with its test. Deletion test: passes, but
the comment documents how to re-enable, so leave it.
**`tools/tool-git-hooks/src/install.ts` | 21.** none / none / prints
"pre-commit + commit-msg are active" — **false**, commit-msg is disabled.
**`tools/tool-observability-stack/src/validate.ts` | 65.** JSON/YAML shape check;
`validateDashboardJson` checks `uid` is a string and `panels` is an array and
nothing else. / none / two near-identical try/catch validators.
**`tools/tool-secrets/src/cli/{push,encrypt,decrypt,updatekeys}.ts` | 20/16/16/16.**
**All four print "would run: sops …" and exit 0.** Four Nx targets that cannot
fail. `shared.ts`'s `assertRealCiphertext` (`:16`) is the only real logic and it
guards nothing that acts. LLM_README calls this "lower priority"; it is four
entries on the checks-that-cannot-fail ledger.
**`tools/dev/setup.ts` | 76.** `MissingEnvExampleError` (`:26`) separates "steady
state" from "broken checkout" — model R5. none / none / clean.

---

## 2 · `bin/*` — file by file

| file                            | LOC  | role                       | finding                                                                                                                             |
| ------------------------------- | ---- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bin/h2puni-gate.sh`            | 12   | the canonical gate         | **`--skip-nx-cache`.** The one command AGENTS.md tells every agent to run before claiming done discards every cache hit. See §5-D1. |
| `bin/with-heavy-lock.sh`        | 12   | host mutex wrapper         | correct; `resolve_heavy_lock_path` is what un-broke it on Macs                                                                      |
| `bin/heavy-lock-lib.sh`         | ~200 | the mutex itself           | tested from `tools/tool-dagger/src/heavy-lock.test.ts` — a _dagger_ test owning the _gate's_ lock. Wrong home; see §5-D2            |
| `bin/heavy-lock.test.sh`        | ~170 | shell self-test            | run as its own CI step                                                                                                              |
| `bin/assert-no-prod-release.sh` | ~110 | one-migration precondition | exemplary: three readings of the state dir, absent ≠ empty                                                                          |
| `bin/dev-deploy.sh`             | ~200 | dev trigger                | correct; the poller note (`:4–13`) records a doc that was wrong for 12 days                                                         |
| `bin/dev-be-probe.sh`           | 15   | auth-routes probe          | pins on an exact JSON body — brittle but deliberate, with a proof line                                                              |
| `bin/dev-mcp-preflight.sh`      | ~70  | MCP env preflight          | —                                                                                                                                   |
| `bin/dev-mcp-probe.sh`          | ~90  | MCP semantic probe         | —                                                                                                                                   |
| `bin/publish-release.sh`        | 9    | release entry              | —                                                                                                                                   |

**Cross-cutting:** five `bin/*.sh` files are _tested_ by TS suites in three
different Nx projects (`tool-devsync`, `tool-deploy`, `tool-dagger`) and
_shellchecked_ by two more `build` targets (`tool-deploy:build`,
`tool-devsync:build`, `tool-bootstrap:build`). **None of those targets declares
`bin/**`in its`inputs`.** `nx.json`'s `sharedGlobals`lists five workspace
files and`bin/`is not among them, and`default`is`{projectRoot}/**/\*`. So
editing `bin/dev-deploy.sh` invalidates **no\*\* cache entry: `tool-devsync:build`
(the shellcheck) and `tool-devsync:test` both replay from cache and report green
on a script they did not read. This is a cache-correctness hole, not a speed
one — and `h2puni-gate.sh`'s `--skip-nx-cache` is currently the only thing
hiding it.

---

## 3 · `deploy/**`

| file | LOC | role | finding |
| ----------------------------------------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `deploy/compose/base.yml` | 88 | edge Caddy + private registry | reuse: none. perf: none. DDD: the `wbs-dev-net` external-network comment (`:11–18`) is the reason dev survives a prod teardown. Checked by CI's `Compose files` step (`docker compose config -q` + a `jq -e` on the network) — a real check |
| `deploy/compose/base.dev.yml` | 23 | dev overlay | not covered by CI's compose step (only `base.yml` and `dev-src/compose.yml` are) |
| `deploy/dev-src/compose.yml` | 68 | the one dev container | perf: `mem_limit 1536m`, `cpus 1.5`, `pids_limit 512`, measured at 278 MiB steady — sized, not guessed |
| `deploy/dev-src/Dockerfile` | 31 | dev image | — |
| `deploy/compose/Caddyfile.bootstrap` | 38 | placeholder vhost | the thing `caddy reload`'s exit-0 defect kept serving |
| `deploy/compose/site-dev.caddy.candidate` | 60 | dev vhost draft | **duplicates `lib/site.ts:5`'s `DEV_MCP_ROUTES`**; only the TS copy is rendered |
| `deploy/compose/log-redact.caddy` | 59, `registry.caddy` | 20 | edge fragments | — |

The two `.tmpl` files (`tools/tool-compose/src/templates/`) are the rendered
path and are inlined into `swap.js` at build time — good depth, one file ships
the templates.

---

## 4 · Gate configuration — performance axis

### 4.1 Nx `inputs` / caching correctness (per `project.json` + `nx.json`)

| target                                                   | `inputs` correct?          | why                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<app>:build`, `<lib>:test`, `<p>:lint`, `<p>:typecheck` | yes (via `targetDefaults`) | `default` = `{projectRoot}/**/*` + `sharedGlobals`                                                                                                                                                                                               |
| `tool-deploy:build`                                      | **no**                     | shellchecks `bin/assert-no-prod-release.sh`, outside `projectRoot`, absent from `sharedGlobals`                                                                                                                                                  |
| `tool-devsync:build`                                     | **no**                     | shellchecks four `bin/*.sh`                                                                                                                                                                                                                      |
| `tool-devsync:test`                                      | **no**                     | three test files read `../../../bin/*.sh`                                                                                                                                                                                                        |
| `tool-deploy:test`                                       | **no**                     | reads `../../../bin/assert-no-prod-release.sh`                                                                                                                                                                                                   |
| `tool-dagger:test`                                       | **no**                     | reads `../../../bin/with-heavy-lock.sh` + `heavy-lock-lib.sh`                                                                                                                                                                                    |
| `tool-compose:test`                                      | **no**                     | reads `../../../deploy/compose/*`                                                                                                                                                                                                                |
| `tool-bootstrap:test`                                    | **no**                     | reads `../../../deploy/compose/{Caddyfile.bootstrap,log-redact.caddy}`                                                                                                                                                                           |
| `tool-dagger:test-be/-gw/-fe`                            | **no, and inverted**       | the target _is_ `nx test be-01` but is cached on **tool-dagger's** inputs. A be-01 source change does not invalidate it. `publish-be` `dependsOn` it, so a publish can satisfy its test dependency from a cache entry keyed on the wrong project |
| `tool-dagger:build-be/-gw/-fe`                           | n/a                        | declared `outputs` (`dist/tool-dagger/release-*`) are never written                                                                                                                                                                              |

Fix for all but the last two: add `{workspaceRoot}/bin/**`, `{workspaceRoot}/deploy/**`
to `sharedGlobals`, or per-target `inputs`. Seven wrong entries, ~10 lines.

### 4.2 `--skip-nx-cache` in the canonical gate

`bin/h2puni-gate.sh:8` runs `nx run-many -t test lint typecheck build
--parallel=2 --skip-nx-cache`. Every agent is told to run this before claiming
done. It rebuilds 23 projects × 4 targets from scratch every time. The flag is
undocumented — nothing in AGENTS.md, LLM*README.md, or the script says why. It
is plausibly there \_because* §4.1's inputs are wrong; if so, fixing the inputs
retires the flag and the gate's wall clock drops by whatever the cache would
have hit.

### 4.3 CI `run-many` vs `affected`

`.github/workflows/ci.yml:19` argues run-many on a "~10k LOC is cheap"
rationale. The repo is ~183k LOC and `gate` + `pixels` now run 20 + 25 minutes.
The rationale is stale. But `affected` is **not safe yet** for the seven targets
in §4.1 — their real inputs are outside the project graph, so `affected` would
under-select exactly them. Sequence: fix inputs → then reconsider `affected`.
`fetch-depth: 0` is already in place for it.

### 4.4 The typecheck targets — 17 of 23 check zero files

**Freshly proven this session.** `libs/{domain,config,contracts,observability,realtime,scripts,validation}`
and `tools/{tool-remote-scripts,tool-deploy,tool-dagger,tool-smoke,tool-bootstrap,tool-compose,tool-devsync,tool-git-hooks,tool-observability-stack,tool-secrets}`
all run `bunx tsc --noEmit -p <p>/tsconfig.json`. Each of those `tsconfig.json`
files is a **solution config**: `"files": []`, `"include": []`, `references` only.
`tsc --noEmit -p` does not follow references (only `--build` does).

```
$ bunx tsc --noEmit -p libs/domain/tsconfig.json --listFiles | wc -l
0                                   # 0.39s
$ bunx tsc --noEmit -p libs/domain/tsconfig.lib.json --listFiles | grep -c libs/domain
15
```

Same result for all 17. Real: `be-01`, `gw-01`, `mcp-01`, `fe-01` (`tsc --build
--force`), `auth` (`--build` + a real spec config), `tool-dev-setup`
(non-solution `include`).

Consequences, in order of severity:

1. **`tools/**`is typechecked by nothing.**`apps/be-01:typecheck`pulls 40`libs/`files transitively but **0**`tools/`files.`swap.ts`— 1,033 lines
   that swap production — is covered only by ESLint's typed rules (which _do_
   work:`projectService`finds`tsconfig.lib.json`).
2. **Every lib's test files are typechecked by nothing.** `tsconfig.spec.json`
   is referenced and never entered; consumers pull production sources only.
3. It is fast for the wrong reason: 0.39s × 17 looks like a healthy typecheck
   tier.

Fix: `tsc --build <p>/tsconfig.json` (one word per target, 17 lines). Expect it
to surface real errors on first run — that is the point.

### 4.5 Playwright — the largest single e2e lever

`apps/fe-01/playwright.config.ts`: `fullyParallel: false`, `workers: 1`,
`retries: 0`, `timeout` 120s CI / 60s local, `expect.timeout` 30s CI / 10s local,
`trace: 'retain-on-failure'`, one chromium. 229 cases, ~15.1 min on the runner
against a cap of 25.

- `workers: 1` is **not argued anywhere in the file**, unlike every other
  setting here (each of which carries a measurement). The three servers are
  started once via `webServer` and shared; each spec seeds its **own account and
  own project through the UI**, so cross-test state is already isolated at the
  data level. The blockers to `workers: 4` are (a) `E2E_PORT_SHIFT` moves all
  three tiers together but there is one stack per _run_, not per worker — which
  is fine, workers share it — and (b) one SQLite file under concurrent writers,
  which `db.ts` already sets WAL + `busy_timeout` for. This is the single
  highest-leverage unexplored change in the gate: 15 min → ~4–5 min.
- `retries: 0` is correct and argued; do not touch it.
- The 30s `expect.timeout` (raised after four one-case CI losses on 2026-08-31)
  is the honest fix and is documented with the byte-identical-tree proof.
- `reuseExistingServer: !isCi` is the LLM_README landmine and is correctly
  flagged there.

### 4.6 vitest (fe-01)

`apps/fe-01/vitest.config.ts` sets `environment: 'jsdom'`, `globals: true`,
`setupFiles`, `include`, and **no `pool`, no `poolOptions`, no `isolate`, no
`projects`**. Vitest 1 defaults to threads with `maxThreads = cpus` and
`isolate: true`, so files parallelise but a single file does not.
`wbs-table.test.tsx` is now **16,855 LOC** (audit: 15,570) and is the whole
critical path. There is no `test:unit`/`test:dom` split and no `projects` block,
so there is no way to run the pure-TS fe-01 suites (`table-frame.test.ts` 1,044,
`gantt-geometry.test.ts` 3,074, `plan-export.test.ts` 1,118,
`plan-mermaid.test.ts` 889 — 6,125 LOC of jsdom-free tests) without booting
jsdom and collecting the 16k-line file.

`vitest.setup.ts` (172) is genuinely good: four platform stand-ins
(`localStorage`, a **driveable** `matchMedia` with a `listenerCount` that lets
an unmount be asserted, `scrollTo` silencing, `getComputedTextLength`), each
installed only when missing, each with the probe date and the fault it exists to
expose. `DriveableMediaQueryList.listenerCount` (`:48`) is the sharpest test
seam in fe-01.

### 4.7 lefthook / eslint / tsconfig.base / root package.json

- `lefthook.yml` (31): lints and prettier-checks staged files, runs the two
  scanners, doc-caps. **Runs zero tests.** The `CLAUDE.md`/`GEMINI.md` exclusion
  comment (`:11–14`) is correct and non-obvious.
- `eslint.config.js` (215): `strictTypeChecked` + `stylisticTypeChecked` +
  `projectService: true` for everything. The `@nx/enforce-module-boundaries`
  scope/runtime tag matrix (`:16–37`) is good and holds. The `bun:sqlite`
  restricted-import block (`:131–166`) and the jsdoc block (`:169–205`) are both
  arguments-as-config done right — the jsdoc comment explaining why
  `require-jsdoc` is _deliberately absent_ is the best single paragraph of R5
  reasoning in the repo. **No `--cache` anywhere**; no `lint:fast` tier.
- `tsconfig.base.json` (58): the eight `@wbs/domain/*` deep aliases are declared
  in **six** places — here, `apps/fe-01/tsconfig.json`, `tsconfig.app.json`,
  `tsconfig.e2e.json`, `vite.config.ts`, `vitest.config.ts`. `vite-config.test.ts`
  asserts two of them agree as sets (after the drift happened three times, costing
  8 uncollected files and a green 835-assertion run). Four copies remain unasserted.
- root `package.json` (150): `test` = `nx run-many -t test`; no `test:unit`, no
  `typecheck:fast`, no `lint:fast`. `bun test` at the root is a trap
  (LLM_README says so) and nothing mechanical stops it.

---

## 5 · `apps/fe-01/e2e/**` — file by file

24 specs (19,020 LOC) + 2 helpers (178 LOC). 229 cases. One shared helper module
imported 22×.

| file                           | LOC   | cases | reuse                                                                                                                    | perf                                                   | readability/DDD                                                                                                                               |
| ------------------------------ | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-project.ts`            | 49    | —     | **the one working seam**; 22 of 24 specs import it                                                                       | none                                                   | model doc comment: names the two faults that broke specs that walked past it                                                                  |
| `measure-ink.ts`               | 129   | —     | imported by 2 (`priority-ramp`, one other)                                                                               | rasterises through a canvas per call                   | `NEUTRAL_CHROMA` / `NAMELESS_CHROMA_FOR_GREY_INK` are named domain thresholds with the palette numbers that set them — exemplary              |
| `layout.spec.ts`               | 3,621 | 53    | own `seedPlan` (`:194`); 24 local fns                                                                                    | seeds via UI per test, ~2s each ≈ 106s of pure seeding | the best spec: re-derives every expectation through `frameLayout` rather than pinning literals; `declaredLeft` (`:~290`) states its own limit |
| `gantt.spec.ts`                | 3,579 | ~30   | own helpers                                                                                                              | UI seed                                                | —                                                                                                                                             |
| `hover-cards.spec.ts`          | 1,522 | 26    | own `seedPlan` (`:22`) — a near-copy of layout's                                                                         | UI seed; 9 `toHaveCount(0)`                            | `settledRowBg` (`:407`) is a third settle helper                                                                                              |
| `mobile.spec.ts`               | 1,423 | 19    | own `seedPlan` (`:93`)                                                                                                   | UI seed                                                | —                                                                                                                                             |
| `keyboard.spec.ts`             | 943   | 19    | 9 local fns                                                                                                              | **8 `waitForTimeout`** — the worst pacing in the suite | `dateSegmentOrder` reads the browser's own segment order before typing — the right fix, documented                                            |
| `reference-cells.spec.ts`      | 897   | 4     | own `chooseTheme` (`:153`); 11 local fns                                                                                 | 10 `toHaveCount(0)`                                    | 11 helpers for 4 cases                                                                                                                        |
| `deps-cell.spec.ts`            | 811   | 10    | own `chooseTheme` (`:68`)                                                                                                | —                                                      | its `chooseTheme` carries a 20-line comment re-deriving `dark-mode.spec.ts`'s animation measurement                                           |
| `name-cell.spec.ts`            | 604   | 8     | own `settled` (`:156`), `settledHeight` (`:173`)                                                                         | 1 `waitForTimeout`                                     | —                                                                                                                                             |
| `header.spec.ts`               | 595   | 10    | 9 local fns                                                                                                              | —                                                      | —                                                                                                                                             |
| `dark-mode.spec.ts`            | 544   | 12    | **origin of both duplicated helpers**: `seedPlan` `:23`, `chooseTheme` `:111`, `settled` `:97`, `accountTrigger` `:~105` | —                                                      | the animation measurement (155→42 at 425ms) lives here and is quoted by four other files                                                      |
| `external-refs.spec.ts`        | 485   | 5     | own `chooseTheme` (`:131`)                                                                                               | —                                                      | —                                                                                                                                             |
| `plan-surface.spec.ts`         | 451   | 6     | own `seedPlan(page, _account, rows)` (`:67`)                                                                             | UI seed, parameterised row count                       | —                                                                                                                                             |
| `hints.spec.ts`                | 401   | 6     | 1 local fn                                                                                                               | **7 `waitForTimeout`**                                 | —                                                                                                                                             |
| `name-markdown.spec.ts`        | 392   | 6     | —                                                                                                                        | —                                                      | —                                                                                                                                             |
| `reference-cell-panel.spec.ts` | 367   | 6     | —                                                                                                                        | —                                                      | —                                                                                                                                             |
| `priority-ramp.spec.ts`        | 328   | 4     | own `seedPlan` (`:58`) **and** own `chooseTheme` (`:155`) **and** own `settled` (`:141`)                                 | —                                                      | the only spec importing `measure-ink` for its figures                                                                                         |
| `directory.spec.ts`            | 302   | 7     | 5 local fns                                                                                                              | —                                                      | —                                                                                                                                             |
| `slack-cell.spec.ts`           | 282   | 1     | own `chooseTheme` (`:158`), `seedPlan` (`:175`), `settled` (`:144`) — **three copies for one test**                      | —                                                      | —                                                                                                                                             |
| `types-cell.spec.ts`           | 279   | 5     | —                                                                                                                        | 6 `toHaveCount(0)`                                     | —                                                                                                                                             |
| `tailwind.spec.ts`             | 274   | 6     | `openChromeControl` — the helper `create-project.ts` documents having broken                                             | 4 `page.goto`                                          | —                                                                                                                                             |
| `live-caret.spec.ts`           | 269   | 1     | 4 local fns                                                                                                              | —                                                      | —                                                                                                                                             |
| `steps.spec.ts`                | 261   | 7     | —                                                                                                                        | —                                                      | —                                                                                                                                             |
| `project-picker.spec.ts`       | 233   | 6     | —                                                                                                                        | —                                                      | —                                                                                                                                             |
| `project-settings.spec.ts`     | 157   | 2     | —                                                                                                                        | —                                                      | —                                                                                                                                             |

**Aggregate e2e findings.**
_Reuse:_ `seedPlan` ×7, `chooseTheme` ×6, `settled` ×4, `accountTrigger`
(`header button[aria-haspopup="menu"]`) ×5 — and the copies have **diverged**:
`dark-mode`'s `chooseTheme` presses Escape and calls `settled`, `deps-cell`'s
additionally asserts the menu item is hidden, `priority-ramp`'s polls
`getAnimations()` down to 42. Seven `getAnimations` pollers across the suite,
each with its own threshold. This is the "the repo knows two things must behave
identically and achieves it by copying" pattern, in the slowest tier.
_Performance:_ **every seed goes through the UI.** `page.goto('/')` → wait for
`local-dev` → `createProject` → click `Add work item` ×N → `fill` + `blur` each
name → `fill` + `blur` each estimate → in three specs, hover a tooltip and wait
for it to disappear as a persistence barrier. That is 8–15 cross-process round
trips per test, ~2s locally and materially more on the runner, before the first
assertion. be-01 exposes `POST /api/projects` and `POST /api/projects/:id/commands`;
an API-seeded `seedPlan` that only drives the UI for the _last_ interaction
would cut the dominant cost. Three specs' seeds explicitly say they must go
through the UI (`layout.spec.ts:~185` — "none of that exists in a plan seeded
behind the table's back"); the other four say nothing of the sort.
_Pacing:_ 16 `waitForTimeout` calls, 15 of them in `hints` and `keyboard`.
_Readability/DDD:_ the specs are the best-documented tests in the repo and every
non-obvious wait carries the CI run number that forced it. The problem is
locality: a reader who wants "how does a spec make a plan" has seven answers.

---

## 6 · be-01 and fe-01 test infrastructure

### `apps/be-01/src/testing/**` — 19 modules, 2,031 LOC

| module                                                                                                                                                                                                                                                                                                                                                                                                                        | LOC | role                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------- |
| `directory-fixture.ts`                                                                                                                                                                                                                                                                                                                                                                                                        | 379 | in-memory `DirectoryStore`               |
| `work-item-fixture.ts`                                                                                                                                                                                                                                                                                                                                                                                                        | 316 | in-memory `WorkItemStore` + `stampsSeen` |
| `assumed-duration-oracle.ts`                                                                                                                                                                                                                                                                                                                                                                                                  | 224 | oracle, not a store                      |
| `project-fixture.ts` 133, `step-fixture.ts` 126, `auth-fixture.ts` 99, `capacity-fixture.ts` 96, `command-journal-fixture.ts` 93, `subtree-fixture.ts` 86, `priority-band-fixture.ts` 82, `replay-fixture.ts` 59, `history-fixture.ts` 59, `measure-fixture.ts` 52, `dependency-fixture.ts` 46, `progress-fixture.ts` 41, `estimate-fixture.ts` 41, `actual-fixture.ts` 41, `writes-fixture.ts` 35, `broadcast-fixture.ts` 23 |     |                                          |

**Every one of the 19 opens no database** — verified: zero references to
`openDrizzle`, `mkdtemp`, `runMigrations` or `Database` across the directory. The
T0 tier's raw material already exists and is high quality: `inMemoryWorkItems`
takes an optional `teams` argument so it can refuse `unknown_service` exactly as
the repository does, and its doc comment names the chunk where the absence of
that check let a route's 404 arm go untested.

**What is missing is one file.** There is no `harness.ts`. So 24 test files
hand-assemble the 13-port `WorkItemService` constructor themselves
(`undo.test.ts:111–125` is representative), and the hand-assembly **leaks**: that
same block passes `subtrees: new SubtreeRepository(db)` — a real SQLite repository
inside an otherwise in-memory graph. `buildServices()` (`apps/be-01/src/services.ts:84`)
is the right shape (one function, ten services, the shared-`ReplayBuffer` and
shared-`GatewayBroadcaster` invariants asserted by `services.test.ts`) but takes
a `Drizzle`, so it can only ever serve T1.

`apps/be-01/src/service/fixtures/` is two JSON oracles, not code:
`capacity-oracle-2026-08-13.json` (15,707 lines) and
`live-plan-2026-08-09.json` (211). Golden-file inputs for
`capacity-migration-identity.test.ts` and `live-plan-identity.test.ts`. No
finding beyond: they are in `default` inputs, so they correctly invalidate
be-01's test cache.

**Perf:** 34 of 91 be-01 test files open SQLite when an in-memory fixture for
their store already exists; 41 repeat `mkdtemp + runMigrations`. `bun test` is
55.8s and roughly doubled in 155 commits (26.6s → 55.8s while test count grew
1,203 → 1,261 — so the growth is _per-test cost_, i.e. more DB opens, not more
tests).

### fe-01 — no test infrastructure module exists

`apps/fe-01/src/testing/` does not exist. Seven test files build their own
`ProjectApi`:

| file                                           | fake                                                        | LOC   |
| ---------------------------------------------- | ----------------------------------------------------------- | ----- |
| `components/wbs/wbs-table.test.tsx`            | `fakeApi()` `:97–770` + **28 ad-hoc `ProjectApi` literals** | 673 + |
| `components/wbs/plan-cards.test.tsx`           | `fakeApi(options)` `:94–481`                                | 387   |
| `components/directory/directory-page.test.tsx` | `DirectoryApi` fake `:53–309`                               | 256   |
| `components/wbs/gantt-panel.test.tsx`          | `fakeApi(startDate, skew)` `:3155–3230`                     | 75    |
| `components/wbs/project-page.test.tsx`         | 2 literals                                                  | —     |
| `components/ui/page-shortcuts.test.tsx`        | 2 literals                                                  | —     |
| `app-router.test.tsx`                          | 1 literal                                                   | —     |

~1,400 LOC of fakes for one interface. `wbs-table.test.tsx`'s eight `watchX(api)`
wrappers (`:2795`, `:3172`, `:4454`, `:4977`, `:5639`, `:7301`, `:8529`, `:13761`)
are eight spellings of "record what this method was called with".

`vitest.setup.ts` is the counter-example: it _is_ a shared testing module, it is
excellent, and it is the only one.

---

## 7 · Deepening candidates (this area)

### 1. `tsc --build` for the 17 vacuous typecheck targets

**Files:** all 17 `project.json` `typecheck` targets (one word each).
**Problem:** 17 of 23 typecheck targets load **0 files** (proven, §4.4).
`tools/**` — including `swap.ts`, which swaps production — is typechecked by
nothing, and every lib's test files are typechecked by nothing.
**Solution:** `tsc --noEmit -p <p>/tsconfig.json` → `tsc --build <p>/tsconfig.json`.
Drop `--force` locally, keep it in CI (`nx.json` `targetDefaults` can carry the
difference), per the audit's L1.4.
**Benefits:** _locality_ — the check that answers "did I break this project" is
in that project. _Leverage_ — one word × 17. _Tests_ — this will fail on first
run; each failure is a type error that has been latent.
**Effort:** 1h to change, unknown to fix what it finds. **Risk:** low mechanically,
unknown in fallout. **Deletion test:** the current targets could be deleted
outright with zero loss of signal — that is the argument for the fix.

### 2. `apps/be-01/src/testing/harness.ts`

**Files:** new `harness.ts`; 24 test files lose their wiring blocks.
**Problem:** the 19 in-memory fixtures exist and none of them is composed. Every
one of the 24 files re-derives the 13-port `WorkItemService` graph, and
`undo.test.ts:122` proves the hand-wiring leaks a real `SubtreeRepository(db)`
into an in-memory graph.
**Solution:** `inMemoryServices(overrides?)` returning the same `BeServices`
shape `buildServices()` returns, composed from `src/testing/*`. `buildServices()`
stays the T1 composer over a `Drizzle`; the harness is its T0 twin, and the two
share the `BeServices` interface so a suite can be moved between tiers by
changing one line.
**Benefits:** _locality_ — one place that knows the service graph. _Leverage_ —
~1,200 LOC deleted; the shared-broadcaster invariant becomes assertable at T0.
_Tests_ — most of the 34 DB-opening files stop opening a DB; be-01's 55.8s
should fall to the audit's ~15s target.
**Effort:** ~2 days. **Risk:** low. **Deletion test:** delete the harness and 24
files re-grow their wiring — which is what "this is the missing module" means.

### 3. `apps/fe-01/src/testing/fake-api.ts`

**Files:** new module; 7 test files.
**Problem:** ~1,400 LOC across seven independent `ProjectApi` implementations,
29 literal sites in `wbs-table.test.tsx` alone, no `src/testing/` at all.
**Solution:** one `fakeProjectApi(seed?)` with a recorded call log
(subsuming the eight `watchX` wrappers) plus `fakeDirectoryApi`. Do this
**before** splitting `wbs-table.test.tsx`, so the split files import a fake
rather than each inheriting a copy.
**Benefits:** _locality_, _leverage_ (~1,000 LOC), and it is the precondition for
running the fe-01 suites in parallel.
**Effort:** ~1.5 days. **Risk:** low. **Deletion test:** passes — nothing
production imports it.

### 4. Playwright `workers: 4` + an API-seeded `seedPlan`

**Files:** `playwright.config.ts:~215`; new `e2e/seed-plan.ts`; 7 specs.
**Problem:** 229 cases serial, ~15.1 min of a 25 min cap, every one of them
seeding a plan through 8–15 UI round trips. `workers: 1` is the only setting in
that file with no argument attached to it.
**Solution:** (a) one shared `seedPlan(page, shape)` in `e2e/`, matching
`create-project.ts`'s existing role, seeding through `POST /api/projects` +
`POST /api/projects/:id/commands` and dropping into the UI only where a spec's
own comment says the UI is the subject; (b) then raise `workers`. Keep
`retries: 0`.
**Benefits:** _leverage_ — this is the single largest wall-clock item in the
gate, and the cap that cancelled a run on 2026-08-31 stops being a live risk.
_Locality_ — one answer to "how does a spec make a plan" instead of seven.
**Effort:** ~1 day for the helper, ~½ day to prove `workers: 4` against one
SQLite file. **Risk:** medium — WAL under four writers needs proving, and
`layout.spec.ts`'s "not seeded behind the table's back" constraint must be
honoured per-spec, not overridden. **Deletion test:** the helper is imported by
7 specs; deleting it re-grows 7 copies.

### 5. Retire `tool-dagger`'s three per-tier scripts

**Files:** `tools/tool-dagger/src/{be-01,gw-01,fe-01}.ts`, `lib/image.ts`,
`lib/bundle.ts`, `dagger.test.ts`; six `project.json` targets.
**Problem:** ~220 LOC describing a tarball release format that does not exist,
three files that differ by a tier letter, `lib/image.ts` naming base images and
entrypoints that contradict the real Dockerfiles, and three Nx targets whose
declared `outputs` are never written but which `publish-*` `dependsOn`.
**Solution:** delete. Keep `publish-all`.
**Benefits:** _locality_ — one answer to "what image is a tier". _Leverage_ — the
Nx graph stops carrying six phantom targets.
**Effort:** 1h. **Risk:** none. **Deletion test:** passes outright.

### 6. Cross-project `inputs` for `bin/` and `deploy/`

**Files:** `nx.json` `sharedGlobals`, or seven `project.json` targets.
**Problem:** seven targets read files outside their `projectRoot`
(`bin/*.sh`, `deploy/compose/*`) and declare none of them. Editing
`bin/dev-deploy.sh` invalidates nothing; the shellcheck that guards it replays
from cache and reports green. Today this is masked by `--skip-nx-cache` in
`h2puni-gate.sh` — masked, not fixed, and CI's cache is a different story.
**Solution:** add `{workspaceRoot}/bin/**` and `{workspaceRoot}/deploy/**` to
`sharedGlobals` (blunt, ~2 lines, over-invalidates) or per-target `inputs`
(precise, ~10 lines). Then delete `--skip-nx-cache` and measure the gate.
**Benefits:** correctness first, then wall clock; and it is the precondition for
CI's `run-many` → `affected`.
**Effort:** 2h + one measured gate run. **Risk:** low.

### 7. One `@wbs/tool-deploy-contract` (or widen `@wbs/tool-env`)

**Files:** `tool-remote-scripts/src/lib/{docker,state}.ts`,
`tool-deploy/src/{deploy,affected,remote-state}.ts`,
`tool-dagger/src/lib/publish.ts`, `tool-smoke/src/health.ts`,
`tool-remote-scripts/src/install.ts`.
**Problem:** `Tier` declared 3×, `IMAGE_NAME` 2×, `PORT`/health-path 3×,
`BUNDLE_FILES` 2×, `sha256File` + `parseSha256sumOutput` 2× verbatim, the
`git status --porcelain` clean-tree gate 2×. Five sites justify this with
_"that project has no `@wbs/_`public entry point"* — and`tsconfig.base.json:47`maps`@wbs/tool-env`into`tool-remote-scripts`, which `deploy.ts`imports on its
own line 9. **The stated reason for the duplication is false in the file that
states it.** The live consequence is the`install.ts`-has-no-`--env`defect (§1):
two halves of one contract that disagree about which environment they are in.
**Solution:** widen the existing`@wbs/tool-env`alias to a small`@wbs/deploy-contract`index exporting`Tier`, `Color`, `PORT`, `IMAGE_NAME`,
`BUNDLE_FILES`, `sha256File`, `parseSha256sumOutput`, `assertCleanTree`. Give
`install.ts`an`--env`flag off the same`envLayout`. Follow
`tool-compose/src/index.ts`, which already does exactly this.
**Benefits:** _depth_ — one module, one interface, five consumers. _Locality_ —
the environment question has one answer on both sides of the SSH seam, which is
the property `lib/env.ts`'s own doc comment claims and does not yet have.
**Effort:** ~1 day. **Risk:** low (`enforce-module-boundaries`already permits`scope:infra → scope:infra`).

### 8. Delete both dead SSH builders

**Files:** `tools/tool-deploy/src/ssh.ts` (12), `libs/scripts/src/ssh.ts` (27),
their two test blocks, `libs/scripts/src/index.ts` re-export.
**Problem:** two implementations of "format an ssh/scp command", neither called
by any production path, each with a test proving it still formats a string
nothing sends. `lib/caddy.ts`'s `assembleCaddyfile` (12) is a third of these.
**Effort:** 30 min. **Risk:** none. **Deletion test:** passes.

### 9. `test:unit` / `test:store` tiers + `lint --cache` for the inner loop

**Files:** each `project.json`; root `package.json`; `lefthook.yml`;
`vitest.config.ts` (`projects`).
**Problem:** there is no command that runs only the fast tests. `bun test` at the
root is a documented trap. lefthook runs zero tests. The measured tiers exist
today and nothing names them: `libs/domain` 0.29s, be-01's 57 non-DB files
(unmeasured but bounded by 55.8s − DB cost), fe-01's 6,125 LOC of jsdom-free
suites.
**Solution:** the audit's suffix convention, plus `--cache --cache-location`
on the `lint` targets **only for a new `lint:fast`** (CI and `h2puni-gate.sh`
stay uncached, because a type change in A can stale B's `no-unsafe-*` verdict).
Add `projects` to `vitest.config.ts` so fe-01's pure suites run without jsdom.
**Benefits:** measured 14.7s → 2.4s on be-01 lint, 5.3s → 1.3s on domain.
**Effort:** ~1 day for the tiers, ~1h for the cache. **Risk:** low.
**Note:** the audit's `nx format:check --all` → direct-prettier item is
**withdrawn** — 18.9s vs 17.7s here, and not a like-for-like file set.

---

## 8 · Agentic-workflow notes

**What an agent must know today and cannot discover mechanically.**

1. **`nx run <p>:typecheck` is a no-op for 17 of 23 projects.** An agent that
   edits `tools/tool-remote-scripts/src/swap.ts`, runs `nx run
tool-remote-scripts:typecheck`, sees it pass in 0.4s and reports the change
   type-safe is wrong, and nothing in the repo says so. This is the single most
   dangerous undiscoverable fact in this area. Until candidate 1 lands, the only
   honest type check for `tools/**` is `bunx tsc --build tools/<p>/tsconfig.json`.
2. **Which suite covers what.** There is still no mechanical answer. An agent
   editing `libs/domain/src/workday.ts` must know that `libs/domain:test` covers
   it, that `apps/be-01:test` and `apps/fe-01:test` both consume it, and that
   `vitest.config.ts` needs a matching alias if a _new_ deep entry point is added
   — a fact that has cost three silent losses of 7–8 uncollected files, now
   partly guarded by `vite-config.test.ts` but only across two of six alias
   copies.
3. **Editing a `bin/*.sh` invalidates no Nx cache.** The shellcheck that guards
   it and the TS test that drives it both replay from cache. An agent must run
   the affected project's test target with `--skip-nx-cache`, or run
   `h2puni-gate.sh` (which does it globally, for every project, every time).
4. **`bun test` at the repo root collects fe-01 and fails on the DOM.**
   Documented in LLM_README, enforced by nothing.
5. **A whole-workspace run ≠ the sum of per-project runs** (import-sort errors
   reached main green in every per-project run, 2026-08-30). Documented,
   enforced by nothing.
6. **Two stale landmines.** LLM*README says the WS ping "passes on any first
   message \_containing* `pong`" — `runPingSmoke` has JSON-parsed and matched
   `frame.type` for some time. And the audit's lint timings are ~3× high.
   An agent reading either as current will size work wrong.
7. **`--env` asymmetry.** `tool-deploy` takes `--env`; `tool-remote-scripts:install`
   does not and reads ambient `WBS_ENV`. `deploy.ts`'s own error message tells the
   operator to run the command that will install to the wrong environment.

**What a `src/testing/harness` per app would give.**
Today, "give me a `WorkItemService` I can drive" is 15 lines an agent must
reconstruct from one of 24 slightly different examples — and one of those
examples (`undo.test.ts:122`) silently mixes a real SQLite repository into an
in-memory graph, so copying the wrong one is a trap. A harness turns that into
`const { workItems } = inMemoryServices()` and makes the _choice of tier_ an
explicit, greppable act: `inMemoryServices()` for T0, `buildServices({ db })`
for T1. Same for fe-01: `fakeProjectApi()` replaces seven implementations and 29
ad-hoc literals, and turns "does this component write what I think" from an
eight-variant `watchX` wrapper into one recorded call log. Both harnesses also
give an agent something a comment cannot: a **compiler error** when a port is
added to the service graph, instead of 24 files that still compile because each
one built its own object literal.

**The fastest honest inner-loop command right now** (all measured this session,
this Mac, all under 60s):

```
cd libs/domain && bun test                          # 145 tests, 0.29s   ← fastest real signal
cd apps/be-01  && bun test                          # 1,261 tests, 55.8s ← the real be-01 gate
bunx eslint apps/be-01/src                          # 14.69s cold
bunx eslint --cache --cache-location <scratch> …    # 2.37s warm (13.91s on the write pass)
bunx eslint libs/domain/src                         # 5.31s cold / 1.26s warm
bunx nx format:check --all                          # 18.91s
bunx tsc --build apps/be-01/tsconfig.lib.json       # the only real be-01 typecheck
```

Honest answer for "I touched a domain rule": `cd libs/domain && bun test` — 0.29s.
Honest answer for "I touched be-01": `cd apps/be-01 && bun test` at 55.8s, and
there is no faster tier because none is defined. Honest answer for "I touched
`tools/`": `bun test` in that tool's directory (fast) **plus**
`bunx tsc --build tools/<p>/tsconfig.json`, because `nx run <p>:typecheck`
answers a question it never asked. Honest answer for "I touched fe-01": there
isn't one under a minute, and candidate 3 + `vitest` `projects` is what creates
one.

Cache location used for every `--cache` measurement above:
`/private/tmp/claude-501/…/scratchpad/eslintcache{,-be}` — never inside the repo.
