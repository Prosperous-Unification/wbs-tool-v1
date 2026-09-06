## ADDED Requirements

### Requirement: The optimization toggle gates computation, not display

When the project-wide optimization toggle is OFF, the application SHALL compute the Fast schedule only and SHALL cancel any in-flight solver work; it SHALL NOT start a new solver process. When ON, it SHALL publish the current Fast schedule immediately, SHALL consult the cache for the current input hash, and SHALL start solves only for the variants that are **absent at the current full cache key** — normally one Priority-first (PRI) and one Finish-first (Time) solve on a cold input, and none on a full hit. "Absent" is exact and admits no reading of "stale": a variant holding a `status='failed'` row, a row that reads as `corrupt`, **or** a `status='plan-infeasible'` row for that exact key SHALL NOT be restarted by a read (Sol r10 Important 8 — "missing or stale" let a corrupt `status='ok'` row be treated as stale and auto-respawned, which is the read-triggered retry this design forbids and which the codec requirement forbids explicitly, since a corrupt row must survive for diagnosis). Only an explicit Retry, or a new input hash, SHALL start such a variant — and for a `plan-infeasible` row only a new input hash SHALL, because Retry SHALL answer `409 not-retryable` for it.

#### Scenario: OFF computes Fast only and cancels solver work

- **GIVEN** the optimization toggle is OFF while a solver run is in flight
- **WHEN** the toggle is flipped OFF
- **THEN** the in-flight solver process is terminated, no new process starts, and the Fast schedule remains the only visible schedule

#### Scenario: ON publishes Fast then starts both variants on a cold input

- **GIVEN** the optimization toggle is ON, a debounced edit fires, and the cache holds nothing for the resulting input hash
- **WHEN** the debounce elapses
- **THEN** the Fast schedule is published immediately and one PRI and one Time solve start for the same canonical input

### Requirement: Optimized results are cached against the exact scheduling input

Validated solver results SHALL be stored in a durable SQLite cache keyed by `(projectId, inputHash, objective, contractVersion, budgetMs)`. `contractVersion` SHALL combine the domain scheduler's `SCHEDULER_CONTRACT_VERSION` with the solver package version, because durations, the leaf expansion and `baselineOffsets` are produced by domain code the package version does not describe. A cache entry SHALL be valid only when every key column matches the current state and its generation is still the project's current generation. A cache hit SHALL return the cached schedule directly to the requester, except that a `plan-infeasible` hit SHALL return that typed state and its offending-item payload instead of a schedule, SHALL leave Fast displayed, and SHALL NOT trigger a solve. `plan-infeasible` SHALL be cached and keyed exactly as `ok` is, because it is a deterministic function of the same input, and SHALL NOT suppress the fresh generation a new input hash starts.

#### Scenario: a cache hit returns without a solve

- **GIVEN** a validated PRI and Time pair is cached for the current input hash and objective
- **WHEN** a collaborator reads that project's schedule
- **THEN** the cached result is returned directly and no solver process starts

#### Scenario: a contract version bump invalidates the cache

- **GIVEN** a cached pair recorded under contractVersion `3+v1` while the running contract is `4+v1` — the domain scheduler changed, the Python package did not
- **WHEN** the schedule is read
- **THEN** the cached entry is treated as invalid and a fresh solve starts, because a `solverVersion`-only key would have matched

### Requirement: schedule_optimized broadcasts only newly stored results

The coordinator SHALL emit one `schedule_optimized` event when a newly validated result is stored, carrying the full cache-key identity `(projectId, generation, inputHash, objective, contractVersion, budgetMs)`. A cache hit SHALL NOT emit the event. The guarantee SHALL be one durable `event_log` record per newly stored outcome plus one best-effort post-commit push, stated identically here and in every other normative location; the system SHALL NOT claim delivery over a live socket, because `event_log` is a replay buffer rather than a dispatched-and-acknowledged outbox.

#### Scenario: a newly stored result broadcasts once

- **GIVEN** a solve whose result validates and stores
- **WHEN** the result is stored
- **THEN** exactly one `schedule_optimized` event is emitted for that project

#### Scenario: a cache hit emits nothing

- **GIVEN** a cache hit on read
- **WHEN** a collaborator reads the schedule
- **THEN** no `schedule_optimized` event is emitted

### Requirement: The comparison indicator names the change against Fast

The compact indicator SHALL compare the selected optimized variant with the Fast schedule for the same exact input and SHALL report one of: Earlier by N days, Later by N days, Same deadline + reordered, or Same deadline + same order.

#### Scenario: the selected variant finishes earlier

- **GIVEN** an optimized variant that finishes earlier than Fast for the same input
- **WHEN** that variant is displayed
- **THEN** the indicator reads "Earlier by N days" with the exact day count

### Requirement: Failure keeps Fast usable and requires manual retry

When a solve exits non-zero, times out, is killed, or returns output that fails re-validation, the coordinator SHALL keep showing the Fast schedule, SHALL NOT publish a partial or unvalidated result, SHALL NOT retry on a timer, and SHALL surface a non-intrusive `Optimization unavailable · Retry` indicator. It SHALL record the failure as a `status='failed'` cache row on the same composite key carrying a `failureReason` drawn from `timeout | invalid-output | no-solution | internal-error | oom | horizon-overflow | objective-overflow` and no `resultJson`. The two pre-spawn reasons SHALL write that row and emit the failure event exactly as a spawned failure does, so a client already on screen and a freshly loaded one both reach Retry although no process ever started. That row SHALL NOT satisfy a read, SHALL suppress an automatic re-spawn for that exact key, and SHALL NOT block an explicit Retry or the fresh generation a new input hash starts. The Retry action SHALL recheck the current input hash and launch only a `failed` or `corrupt` variant. An **absent** variant at the current key is `idle` and is admitted by the cold-read path, not by Retry, which SHALL answer `409 not-retryable` naming `idle`.

#### Scenario: a failed solve keeps Fast and offers Retry

- **GIVEN** a solve that times out
- **WHEN** the timeout is observed
- **THEN** the Fast schedule stays visible, a `status='failed'` row with the timeout reason is written, no schedule is published, and the indicator shows "Optimization unavailable · Retry" with no toast or modal

#### Scenario: a failed row never satisfies a read and never auto-restarts

- **GIVEN** a `status='failed'` row for the current input hash and objective
- **WHEN** that objective's schedule is read, repeatedly and by several collaborators
- **THEN** the row is not returned as a schedule, Fast stays visible, no solver process starts on any of those reads, and only an explicit Retry starts a fresh solve for the same key

### Requirement: Solver output is independently re-validated

Every solver response SHALL be a single well-formed JSON line and SHALL be independently re-validated in Bun: every offset present and non-negative, no dependency violated, no pool over capacity in **any** of a slice's named pools (the whole width is spent in each), and no assignee double-booked. Every effective work-item deadline SHALL also be re-validated, and it SHALL be checked on the **materialised** schedule in the real fractional domain as `lastWorkdayOf(start, finish) <= effectiveDeadlineOffset` for every slice, SHALL NOT be checked in quantised units, and a violation SHALL be invalid-output rather than `plan-infeasible`, because a feasible schedule that breaks a deadline is a broken engine rather than an infeasible plan. `objectiveValues[T].value` SHALL be recomputed from the final offsets and matched, and it SHALL be the only recomputed field; `stageValue`, `bound` and `status` describe a stage rather than the published schedule. A response that fails any check SHALL be treated as invalid-output (a failure).

#### Scenario: a malformed response is rejected

- **GIVEN** a solver output that is not one JSON line
- **WHEN** the coordinator reads it
- **THEN** the response is rejected as invalid-output and no result is stored

### Requirement: Resource ceilings cap solver concurrency

The coordinator SHALL cap solver processes at 4 per project and 16 globally. A valid generation SHALL normally use 2 (one PRI and one Time); remaining headroom SHALL cover only termination overlap or future variants, never stale publication — stale publication is prevented by the generation check, not by the slot count. When the global cap is full, entries SHALL wait in a FIFO holding at most one entry per `(projectId, contractVersion, objective, budgetMs)` and ordered by `enqueuedAt`, then `projectId`, then `contractVersion`, then `objective`, then `budgetMs` — the trailing terms are required for a total order, because a project's PRI and Time entries can share a timestamp and two co-existing releases can enqueue the same project and objective in that same millisecond. Each entry SHALL record the `budgetMs` it was enqueued for, since the dequeue cannot otherwise say which budget to launch. Each entry SHALL persist the cancel epoch it was admitted under. At dequeue the coordinator SHALL re-check that the entry's generation is still current for its contract version, that the current cancel epoch equals the admitted one, and that the project's optimization toggle is still ON, and SHALL discard the entry without launching if any check fails. Enforcement scope is defined by the cross-process requirement below.

#### Scenario: the per-project cap holds during overlap

- **GIVEN** a project cancelling its previous generation while launching the next
- **WHEN** overlap is at its maximum
- **THEN** no more than 4 solver processes for that project run at once

### Requirement: The solver wire contract is one versioned schema every consumer reads

The request and the response SHALL be defined by one checked-in JSON Schema, `libs/contracts/solver/solver-wire.v1.json`, and prose SHALL NOT be a second definition. Exactly four consumers SHALL read that file: the Bun request builder, `parseSolverResponse`, the `wbs-solver` Python entrypoint, and a shared golden-fixture corpus both suites run. Every message SHALL carry the required literal `wireVersion`, and the schema SHALL state the unit of every numeric field. <!-- wire-fields:request -->The request SHALL be one JSON line carrying `wireVersion`, `contractVersion`, `solverVersion`, `objective`, `budgetMs`, `stageBudgetSplit`, `quantum`, `horizonUnits`, `slices`, `edges`, `pools`, `baselineOffsets` and `fastHint`. <!-- wire-fields:slice -->Each slice SHALL carry `{ key, durationUnits, width, personId, poolIds, priorityWeight, notBeforeUnits, deadlineUnits }`. The wire property is named `key`; no artifact SHALL spell it sliceKey, unbackticked here deliberately so that the prohibition is not read as a member of the span carrying it. `durationUnits` SHALL be an integer, `poolIds` set-valued, `priorityWeight` and `notBeforeUnits` resolved, and `deadlineUnits` a resolved `integer | null`. `deadlineUnits` SHALL be in the same units as `notBeforeUnits`, `horizonUnits` and every returned offset; it SHALL be the **effective** deadline for that slice, already folded over the tree and already converted to `(D + 1) × quantum`, so the solver applies it without seeing the tree exactly as it never sees `reach`; and `null` SHALL mean unconstrained. `horizonUnits` SHALL be unchanged and SHALL NOT be tightened to the latest deadline, which would make an infeasible plan indistinguishable from a horizon overflow and would remove the serial bound that makes the horizon provably safe. `edges` SHALL already be leaf-expanded with the project's dependency reach applied and SHALL already include the intra-work-item step-order edges, so the solver never receives the tree, `parentId`, or `dep_reach`. `baselineOffsets` SHALL be the **quantised** Fast baseline for the same canonical input — Fast re-run through `schedule()` over the rounded integer `durationUnits` — the wire's own field name, and the only duration name any artifact uses — expressed in integer solver units — and SHALL NOT be real Fast's offsets, whose fractional `days / width` starts can be infeasible in the integer model on legal widths and would make `fastHint` reject a hint the solver must be able to accept. Real Fast is named **Baseline schedule** and is used only by the real-domain publication guard. `baselineOffsets` SHALL be the only movement reference either objective uses. The solver SHALL NOT read a clock, a database, or any other schedule, and SHALL NOT derive a duration, a priority, or a floor. That prohibition binds the deterministic solve; the process's **lifecycle wrapper** SHALL be permitted to read the clock solely to arm the absolute `childDeadlineAt` it is given, and that instant together with the `attemptToken` SHALL be passed as process arguments rather than as request fields, so neither enters the schema, the golden corpus, or the solved model.

#### Scenario: a consumer that diverges from the schema fails the gate

- **GIVEN** the checked-in wire schema and its golden fixture corpus
- **WHEN** any one of the request builder, the response parser, the Python entrypoint or the generated TypeScript types accepts a message the schema rejects, or rejects one it accepts
- **THEN** the contract test fails, so no consumer can carry a private variant of the request

#### Scenario: the movement term uses the passed baseline, not live state

- **GIVEN** two solves for the same input hash with different schedules already published
- **WHEN** each solve computes its movement term
- **THEN** both use the identical `baselineOffsets` derived from that input, so the input hash fully determines the objective

### Requirement: The solver budget is a cache key dimension

The solver budget SHALL be one configuration value `solverBudgetMs` defaulting to 60000, and the coordinator SHALL kill the child process at `solverBudgetMs + 5000`. `solverBudgetMs` SHALL be excluded from the input hash and SHALL be a column of the cache key, because a larger budget can find a better feasible result. The cached promise SHALL be "the best result found for this input, this contract, this objective, at this budget". Because `budgetMs` is a cache-key column, `solver_slot` and `solver_queue` SHALL each carry it as part of their identity, and every liveness lookup — the `pending` and `retrying` variant states and Retry's `already-running` check — SHALL match the full key including it; otherwise a 60 s and a 120 s solve for one objective collide as one row and a variant reads `retrying` when nothing retried it. The 4-per-project and 16-global ceilings SHALL remain budget-independent, because they count processes rather than keys.

#### Scenario: raising the budget re-solves rather than serving the smaller-budget result

- **GIVEN** a cached validated pair produced under a 60000 ms budget
- **WHEN** `solverBudgetMs` is raised to 300000 and the schedule is read
- **THEN** the read misses, both variants are admitted under the new budget, and the 60000 ms rows are not served

#### Scenario: two budgets for one objective are represented separately

- **GIVEN** two co-existing releases, one configured at 60000 ms and one at 120000 ms, both admitting a PRI solve for the same project, contract version and generation
- **WHEN** both are in flight and each client reads the plan
- **THEN** the two slot rows are distinct, each client reads `pending` for its own budget, the 60 s coordinator's reclaim sweep does not reclaim the 120 s child before that child's own recorded deadline, and the observed process counts still respect 4 per project and 16 globally

#### Scenario: a drain finishes after the coordinator that began it crashed

- **GIVEN** a project deletion whose coordinator commits `optimizationDeletePendingAt` and `draining`, then crashes before calling `finishOptimizationDrain`
- **WHEN** a different coordinator starts, time advances past the affected slots' stored `admittedDeadlineAt`, and its startup and periodic reconciliation run
- **THEN** the remaining slot rows are reclaimed, the project row and its optimization rows are physically deleted, the contract generation is retired, admission is never reopened for that project, and running the reconciler twice concurrently changes nothing and raises nothing

### Requirement: Each solver child is bounded in CPU and memory, not only in count

The process ceilings SHALL NOT be presented as the CPU or memory bound. Every production solve SHALL request `num_search_workers` from `solverSearchWorkers` (default 2), while pinned determinism keeps 1. The host supervisor SHALL refuse more than 2 workers, 512 MiB, 128 PIDs per child, or 16 live managed containers globally before Docker create; deployment may lower but a caller cannot raise those caps. Docker SHALL apply the accepted memory limit and equal memory-swap to the one disposable solver container. `RLIMIT_AS` SHALL remain a loose address-space backstop only. The supervisor SHALL classify `oom` only from Docker's recorded `OOMKilled=true`; its deadline-timer kill SHALL be `timeout`; another native non-zero exit SHALL be `internal-error`. The coordinator SHALL survive every case, retain its slot until termination is proved, then store the typed failure and release. The fleet obligation is 32 CP-SAT search workers and about 8 GiB solver RSS at the full 16.

#### Scenario: a child that crosses its memory limit is recorded as oom

- **GIVEN** a solve configured with `solverMemoryLimitMb` and a fixture that forces native CP-SAT allocation past the limit
- **WHEN** Docker kills the managed container and records `OOMKilled=true`
- **THEN** the coordinator survives, the slot is released only after the terminal evidence, a `failed` marker with `failureReason: 'oom'` is stored, a native abort without that evidence is `internal-error`, and the real solve uses `solverSearchWorkers`

### Requirement: A coordinator restart resumes nothing and publishes nothing stale

On startup the coordinator SHALL resume no in-flight child and SHALL rebuild no **in-memory** queue. It SHALL NOT discard the durable `solver_queue` merely because of the restart: ordinary generation, admission-state, cancel-epoch, toggle, and deletion predicates remain authoritative. A variant absent at the current key SHALL be re-admitted within the same generation only after any orphan slot is released or passes `admittedDeadlineAt`. Coordinator disconnect SHALL make the host supervisor kill that exact managed container. Supervisor restart SHALL NOT unarm the per-attempt systemd deadline timer, and its restart-always pre-listen sweep SHALL kill, wait, inspect, and remove managed orphans. EOF without a terminal frame SHALL keep the slot counted until the child deadline plus reclaim margin. No missed heartbeat alone reclaims a row.

#### Scenario: a mid-solve restart leaves no partial result

- **GIVEN** a solve in flight
- **WHEN** the coordinator process is killed and restarted
- **THEN** no cache row exists for that run, the supervisor or persistent deadline timer terminates the managed container, and its slot stays counted until termination is proved or `now > admittedDeadlineAt`

### Requirement: The toggle, Engine and Objective are persisted project settings

The optimization toggle, Engine, and Objective SHALL be columns on the `project` row — `optimization_enabled` defaulting to false, `schedule_engine` defaulting to `'fast'`, `schedule_objective` defaulting to `'pri'` — readable in the project payload and writable only through a PATCH under the existing project-write authorization. A change to any of them SHALL emit a `project_settings_changed` event and SHALL NOT emit `schedule_optimized`, which is reserved for newly stored solver results.

#### Scenario: an unmigrated project reads OFF

- **GIVEN** a project row that existed before the migration
- **WHEN** the project is read after the migration runs
- **THEN** `optimization_enabled` is false, `schedule_engine` is `fast`, and `schedule_objective` is `pri`, with no backfill required

#### Scenario: a reader cannot change a project setting

- **GIVEN** a collaborator with read-only access to the project
- **WHEN** they PATCH `schedule_engine`
- **THEN** the request is refused and no event is emitted

#### Scenario: switching Objective to a cached variant starts no solve

- **GIVEN** both PRI and Time are cached for the current input hash
- **WHEN** a collaborator switches Objective from Priority-first to Finish-first
- **THEN** `project_settings_changed` broadcasts, no `schedule_optimized` is emitted, and no solver process starts

#### Scenario: a project that opted out while queued burns no slot

- **GIVEN** a queued entry for a project whose optimization toggle is switched OFF while it waits
- **WHEN** that entry reaches the front of the global FIFO
- **THEN** it is discarded without launching, even though its input hash still matches — the toggle is excluded from the hash, so the hash check alone would not catch it

### Requirement: A project keeps only its current generation's rows

Retention SHALL be two rules, because generation changes only when `inputHash` changes and a budget or contract-version change therefore inserts a different composite-key row inside the same generation. First, allocating a new generation SHALL delete every cache row of that project for that contract version. Second, when a new outcome commits, the same transaction SHALL keep the `MAX_LIVE_BUDGETS` (2) most recently written budgets for `(projectId, objective, contractVersion, inputHash)` and delete the rest. The second rule SHALL be a bound rather than an exclusion: deleting every row whose budget differs makes a budget change a livelock, because a configuration change is not a code change and two co-existing releases can therefore read different budgets under one contract version and delete each other's rows on every store, alternating solves for ever on an unchanged plan. Reads are keyed by the current budget, so nothing readable is lost. The resulting bound SHALL be stated everywhere as at most `MAX_LIVE_BUDGETS` (2) rows per project per objective per live contract version — so at most 4 outcome rows per project per live contract version across both objectives — with live contract versions bounded by the `GENERATION_RETENTION_DAYS` (30) retirement rule, and SHALL NOT be restated anywhere as a total of two rows or as superseded rows being deleted on commit. Undoing an edit back to a previous input hash SHALL be a cache miss that re-solves, with Fast visible throughout.

#### Scenario: repeated budget changes stay bounded

- **GIVEN** a project whose `solverBudgetMs` is raised three times and whose contract version is then bumped, with no plan edit
- **WHEN** each new result commits
- **THEN** the least recently written budget row is deleted by the committing transaction and at most two rows per objective per live contract version remain for that project

#### Scenario: two releases reading different budgets do not evict each other

- **GIVEN** two co-existing backend releases against one database file, one configured with a 60 s budget and one with a 120 s budget, for an unchanged plan under one contract version
- **WHEN** each release stores its result and the two then alternate reads ten times
- **THEN** both rows survive, every read after the first two is a cache hit, and exactly two solver processes were spawned in total

#### Scenario: a new generation evicts the previous one

- **GIVEN** a project with a stored PRI and Time pair for hash A
- **WHEN** an edit produces hash B and its generation stores a result
- **THEN** the hash-A rows are gone, and a later undo back to hash A misses the cache and starts a fresh generation while Fast stays visible

### Requirement: The canonical input is the exact argument tuple of the Fast pass

The input hash SHALL be the SHA-256 of a canonical JSON built from every argument `schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)` receives and from nothing else. It SHALL include each row's `id`, `parentId`, `position`, `frozenNumber` and as-written `priority`; the authored dependency edges; the `slices` array **grouped by work item, groups ordered by `workItemId`, each group's own order preserved as given** — only that intra-item order is step precedence, and the order between groups is whatever SQL returned — with each slice's `workItemId`, `stepId`, `days` (null distinct from zero), `personId`, `width` and set-valued `poolIds`; the `notBefore` floors as whole days from day zero (quantised only at the solver boundary); the pool sizes; the project's `dep_reach`; and the work-item `deadlines` as `[workItemId, deadlineOffset]` sorted by id, resolved into whole workdays from day zero exactly as the floors are and keyed by **as-authored** work item ids rather than the leaf expansion, so a parent's deadline edit that binds no leaf today still rehashes. A deadline SHALL NOT become a cache-key column; it SHALL be hashed like every other input. Engine, Objective, the toggle, the display variant, the clock, the acting user and the request sequence SHALL be excluded.

#### Scenario: a dependency-reach change is a different input

- **GIVEN** a cached pair for a project whose `dep_reach` is `whole-item`
- **WHEN** `dep_reach` is changed to `anchor-slice` and the schedule is read
- **THEN** the hash differs, the read misses, and a new generation is admitted

#### Scenario: reordering two slices of one work item is a different input

- **GIVEN** a work item whose two slices are ordered design-then-build
- **WHEN** the order becomes build-then-design and the schedule is read
- **THEN** the hash differs and the read misses, because that order is step precedence

### Requirement: The objectives are defined as executable mathematics

PRI SHALL minimize `(PRIORITY, MAKESPAN, MOVEMENT)` lexicographically and Time SHALL minimize `(MAKESPAN, PRIORITY, MOVEMENT)`, where `MAKESPAN` is the maximum slice finish in quantised workday units, `PRIORITY` is `Σ w(s)·finish(s)` where `w(s)` is the **dense rank** of the leaf priority resolved by `priorityByLeaf`'s **nearest/most-specific override** rule — the first non-null value walking leaf-upward, never a floor or a minimum across ancestors, so a leaf priority of 5 under a parent priority of 1 resolves to 5; the request builder SHALL import that resolver from `libs/domain` rather than reimplement it — `w(s) = (R + 1) − rank(p(s))` over the `R` distinct priorities present in the canonical input, and `w(s) = 0` for an unprioritised leaf. The absolute priority SHALL NOT be used as a weight: the API accepts any safe integer priority with no ceiling, so `P_max + 1` loses integer precision at `Number.MAX_SAFE_INTEGER` and the weighted sum overflows CP-SAT's signed 64-bit linear expressions on legal data. Bun and the wire use JSON numbers, so exactness is the tighter bound: before spawning, the request builder SHALL compute the exact worst cases for `PRIORITY` and `MOVEMENT` and SHALL fail with reason `objective-overflow` when either exceeds `Number.MAX_SAFE_INTEGER`. Every request and response objective integer — `value`, `stageValue`, `bound`, `PRIORITY`, `MAKESPAN`, and `MOVEMENT` — SHALL be a non-negative safe integer; an unsafe response SHALL be `invalid-output`. When no leaf carries a priority, every weight SHALL be zero, so `PRIORITY` is identically zero and PRI degenerates to Time; and `MOVEMENT` is `Σ |start(s) − baselineStart(s)|`. The lexicographic order SHALL be implemented as staged optimization rather than a weighted sum. Neither ordering SHALL be claimed to be a total order, and production SHALL NOT be required to break ties reproducibly.

The request builder SHALL accumulate the preflight worst cases as `bigint` and compare them with `BigInt(Number.MAX_SAFE_INTEGER)` before converting to wire numbers; a bound check performed after inexact `number` multiplication or addition SHALL NOT satisfy this requirement.

#### Scenario: unbounded priorities do not overflow the solver

- **GIVEN** a project whose leaf priorities include `Number.MAX_SAFE_INTEGER` and whose dense-rank sum is at the JSON safe-integer boundary
- **WHEN** the priority term is built
- **THEN** the weights are dense ranks bounded by the number of distinct priorities, an exact sum of `Number.MAX_SAFE_INTEGER` round-trips, a sum one greater fails with `objective-overflow` before any process starts, and a response changed by one is rejected rather than rounded to the same value

#### Scenario: a plan with no priorities is well defined

- **GIVEN** a project where no leaf and no ancestor carries a priority
- **WHEN** PRI is solved
- **THEN** every weight is zero, `PRIORITY` is zero for every placement, and PRI returns a Time-equivalent result rather than an undefined `P_max`

#### Scenario: the two objectives differ only in term precedence

- **GIVEN** one canonical input with at least one prioritised leaf and a resource conflict
- **WHEN** PRI and Time are both solved
- **THEN** both are feasible against the same graph, PRI's `PRIORITY` is no worse than the real Baseline schedule's `PRIORITY`, and Time's `MAKESPAN` is no worse than the real Baseline schedule's `MAKESPAN` after the publication guard — the cross-objective comparison is deliberately **not** required, because two independent time-limited best-found runs cannot guarantee it

### Requirement: Every duration crossing the solver boundary is computed by the caller

Bun SHALL compute every duration and the solver SHALL NOT derive one. The value crossing the boundary SHALL be an integer count of `1 / SOLVER_QUANTUM` workday units, never a whole-day integer and never a raw fraction. The request SHALL contain no null duration.

#### Scenario: an unestimated slice crosses the boundary as its assumed duration

- **GIVEN** a slice whose `days` is null and whose `width` is 1
- **WHEN** the solver request is built
- **THEN** its `durationUnits` is `ASSUMED_SLICE_WORKDAYS × SOLVER_QUANTUM`, and the request contains no null and no fraction

### Requirement: A stale generation can neither publish nor evict

Every spawn SHALL carry `(generation, cancelEpoch, attemptToken)`. That four-part predicate SHALL be scoped to **worker-owned writes** — a solver owner storing its result or its failure, and the retention eviction performed _by_ such an outcome — and SHALL NOT be stated as a universal rule for every eviction (Sol r10 Important 9): generation allocation must delete the prior generation's rows _before_ any new child or token exists, the OFF transition must delete queue rows in the same transaction that clears `optimization_enabled`, and project deletion and contract retirement have no child token at all, so a universal token predicate makes all three impossible. Each authority is defined separately and SHALL be implemented separately: (a) **worker-owned outcome writes** SHALL be conditional, in the same transaction as their event, on all four of the generation still being current for that contract version, the cancel epoch being unchanged, `optimization_enabled` still being 1, and the writer's `attemptToken` still matching its live `solver_slot` row; (b) **allocation eviction** SHALL be authorized by the winning generation compare-and-swap alone, in that same transaction; (c) **OFF cleanup** SHALL be authorized by the `cancelEpoch` increment alone, in that same transaction; (d) **deletion and retirement eviction** SHALL be authorized by their cancel-and-drain protocol alone. A statement failing the predicate of its own authority SHALL match zero rows and its writer SHALL abort rather than store, evict or broadcast.

#### Scenario: an undo back to a previous hash does not revive its old run

- **GIVEN** a run in flight for hash A, an edit to hash B that cancels it, and an undo back to hash A
- **WHEN** the original hash-A child returns a valid result
- **THEN** its write is rejected, no rows are deleted, no `ok` row is overwritten, and no event is emitted, even though the current hash is again A

### Requirement: Resource ceilings are enforced across processes

The per-project ceiling of 4 and global ceiling of 16 SHALL be enforced by the SQLite `solver_slot` admission transaction across backend releases. Every unreleased `starting` or `running` row counts, including cancellation overlap; allocation SHALL NOT delete slots. Admission/dequeue SHALL retain the existing generation, open-state, cancel-epoch, toggle, and deletion fences. Admission mints the attempt token carried by bind, heartbeat, release, outcome, and event writes. After reserving `starting`, the coordinator opens one authenticated host-supervisor connection. The supervisor SHALL derive caller identity with `SO_PEERCRED`, select the host-owned digest mapping, enforce its resource and global caps, and create/attach/start one hardened managed container. Its returned init PID is bound by the existing token CAS; only then may `bound` plus the request reach `wbs-solver-launcher`. Abort, timeout, protocol error, disconnect, or cancellation SHALL kill that exact container and preserve Docker terminal evidence before removal. A transient systemd timer SHALL kill it at `childDeadlineAt`; SQLite alone reclaims after the later `admittedDeadlineAt`. At every sample live managed containers SHALL be no greater than all unreleased slot rows, while solve-start state SHALL be no greater than `running` rows. Queue identity/order and dequeue predicates remain unchanged.

#### Scenario: a coordinator paused between admission and spawn cannot double the ceiling

- **GIVEN** two coordinators against one database, and an owner paused after its slot is inserted `starting` and before its launcher receives the bind verdict, while time advances past the row's stored `admittedDeadlineAt`
- **WHEN** the second coordinator reclaims that expired row and admits a replacement whose launcher binds and `exec`s `wbs-solver`
- **THEN** the delayed bind matches zero, its managed container terminates without a solve, live managed containers never exceed all unreleased rows, solve-start state never exceeds `running` rows, and neither 4 nor 16 is exceeded

#### Scenario: a bind into an already-spent budget does not start a solve

- **GIVEN** an owner paused between the `starting` insert and the spawn for longer than `budgetMs + 5000` but less than `admittedDeadlineAt`, against a row no sweep has reclaimed
- **WHEN** its bind CAS succeeds — token intact, `lifecycle` still `starting` — and the launcher reads a `bound` verdict with `now >= childDeadlineAt`
- **THEN** the supervisor rejects or aborts before solve start rather than arming a non-positive interval, and the slot is released after container termination is proved

#### Scenario: a verdict that never arrives releases the launcher

- **GIVEN** a launcher container blocked for a bind verdict and a coordinator that keeps the connection open without sending one
- **WHEN** `BIND_TIMEOUT_MS = 5000` elapses with stdin still open and no verdict written
- **THEN** the launcher exits without `exec`ing, no `wbs-solver` process is ever created for that token, and the `starting` row is left to ordinary `admittedDeadlineAt` reclaim rather than to a live process holding it

#### Scenario: an old owner cannot outlive its token

- **GIVEN** a slot reclaimed after its stored `admittedDeadlineAt` passed, and re-admitted to a new owner
- **WHEN** the original owner issues a late heartbeat, a release and a result write
- **THEN** all three match zero rows and are refused, only the current token's result can be stored, and exactly one outcome record exists for that key

#### Scenario: rapid generations never exceed the process ceilings

- **GIVEN** a project edited repeatedly so several generations overlap while their children terminate
- **WHEN** managed containers and slot rows are sampled throughout
- **THEN** containers never exceed all unreleased rows, at most 4 for that project or 16 globally, because superseded rows stay counted until termination

#### Scenario: two coordinators share one global budget

- **GIVEN** a blue and a green backend process against the same database file
- **WHEN** both admit solver work until refused
- **THEN** at most 16 solver children run between them, and at most 4 for any one project

#### Scenario: two concurrent first reads start one solve per objective

- **GIVEN** no cached row for a project and two simultaneous reads
- **WHEN** both request admission
- **THEN** exactly one PRI child and one Time child are started, and the losing read waits for the event

#### Scenario: slot capacity is released only after the child deadline margin

- **GIVEN** a child armed at `childDeadlineAt` both in CP-SAT and by the supervisor's persistent systemd kill timer, whose slot stores later `admittedDeadlineAt`
- **WHEN** a sweep at `admittedDeadlineAt` releases that slot and admits a replacement, including the case of a solve that ignores its in-process limit inside a native CP-SAT call
- **THEN** the original operating-system process is already gone because the external kill landed at `childDeadlineAt`, arming the child at `admittedDeadlineAt` instead would fail the process-count ceiling proof, and arming it only in-process would fail it too

### Requirement: A newly stored result and its event commit together

The cache row and a durable `event_log` record SHALL be written in one SQLite transaction, and the broadcaster SHALL push from the committed record. The guarantee SHALL be one durable replay record per newly stored outcome plus one best-effort post-commit push; the system SHALL NOT claim delivery over a live socket, because `event_log` is a replay buffer rather than a dispatched-and-acknowledged outbox and the process can die between the commit and the push. The payload SHALL be `(projectId, generation, inputHash, objective, contractVersion, budgetMs)` so a duplicate delivery is idempotent and a budget change is distinguishable.

#### Scenario: a crash between the row and the event leaves neither

- **GIVEN** a validated solver result
- **WHEN** the process dies after the cache write but before the transaction commits
- **THEN** no cache row and no event record exist, and the next read starts a fresh solve

### Requirement: The solver is a versioned package behind one entrypoint

The solver SHALL ship as its own version-pinned Python package exposing exactly one **solve** entrypoint over stdin/stdout, invoked as a short-lived child process. There SHALL be no import from Bun, no daemon, no listening port, and no sidecar. The same distribution SHALL also ship the **lifecycle launcher** as a second, non-solving console script `wbs-solver-launcher`, which SHALL NOT import CP-SAT and SHALL NOT read the request before its bind verdict; "exactly one entrypoint" scopes the _solve contract_, and does not forbid the launcher the process ceiling depends on (Fable r14 Important 3, which found the launcher specified everywhere and homed nowhere). Production SHALL reach `wbs-solver` only through that launcher, and the built image SHALL be proved to carry both scripts.

#### Scenario: the coordinator invokes the solver only as a child process

- **GIVEN** a solver run
- **WHEN** the coordinator starts it
- **THEN** it spawns `wbs-solver-launcher`, which after a `bound` verdict `exec`s the package's solve entrypoint in place, one JSON line is written to stdin, one JSON line is read from stdout, and the process exits

#### Scenario: the package's solve entrypoint is also directly spawnable as a smoke test

- **GIVEN** the built image and no coordinator
- **WHEN** the solve entrypoint is spawned directly with one JSON line on stdin
- **THEN** it answers on stdout — a package smoke test only, explicitly not the production path, which always goes through `wbs-solver-launcher`

### Requirement: A pending optimized variant keeps Fast on screen

While Engine is Optimized and the selected variant has neither a stored result nor a failure marker, the UI SHALL display the Fast schedule under an `Optimizing…` indicator, and SHALL NOT show a blank schedule, a spinner over the plan, or a stale variant.

#### Scenario: the selected variant is still solving

- **GIVEN** Engine is Optimized, Objective is Priority-first, and PRI is admitted but not stored
- **WHEN** the schedule is read
- **THEN** Fast offsets are returned with an `Optimizing…` indicator

### Requirement: An optimized result is materialised into the full schedule contract

The solver response SHALL carry only `{ wireVersion, status, offsets, objectiveValues }`, and the system SHALL NOT persist or return that offsets map as a schedule. The response `status` SHALL admit `infeasible` as a first-class outcome, and it SHALL NOT be mapped onto `unknown`: `unknown` is budget exhausted with no proof and may become feasible with more budget, while `infeasible` is a proof and never will. The response `status` SHALL be a **run-outcome** enum of exactly `feasible | unknown | infeasible` — a different question from the per-term `status`, which reports a stage's proof strength — and it SHALL NOT admit `optimal`, because a response-level `optimal` would claim the published schedule is optimal, which this design denies. `wireVersion` and `status` SHALL be the only unconditionally required members: a `feasible` response SHALL carry both `offsets` and `objectiveValues`; an `unknown` or `infeasible` response SHALL carry **neither**, because `objectiveValues[T].value` is defined only on a published schedule and an empty `offsets` map would pass the schema and then fail the key-set invariant one layer later. `materialiseOptimized` SHALL be unchanged by deadlines, because it pins the optimized starts and replays Fast's annotation pass and a deadline changes no annotation; the `ScheduleFloor` union SHALL NOT gain a `deadline` member, because a deadline never _causes_ a start. Before storage the system SHALL materialise a complete `Schedule` from the offsets and the canonical input, using a Fast annotation pass with the optimized starts pinned. Because `placeSlices` today chooses starts and annotates in one traversal, Fast SHALL first be split into `chooseStarts(canonicalInput)` and `annotate(canonicalInput, starts)`, proved behaviour-preserving by the existing Fast golden corpus, and `materialiseOptimized` SHALL be `annotate` over the dequantised offsets. `annotate` SHALL replay the person and pool ledgers in ascending start with ties broken by the canonical slice order. It SHALL NOT choose a pool for a multi-pool slice: the whole width is spent in **every** named pool, so `annotate` SHALL call the existing `jointWindowFor(poolIds, width, duration, floor)` and `reserve(poolIds, node, width, start, finish)` unchanged. `annotate` SHALL resolve each slice's floor by Fast's own loop rather than by comparing the joint window to the pinned start: the ordered candidate list `predecessor, stepOrder, notBefore, person, capacity` (the joint window's start), taking a candidate only when it is **strictly** later than the running answer, so a tie keeps the floor named first and `capacity`, being last, loses every tie. The resolved start SHALL then be compared with the pinned start: equal keeps the resolved floor exactly as `boundBy`; pinned strictly later is `optimizer` and the system SHALL assert the pinned start is itself resource-feasible by requiring `jointWindowFor` from it to return it; pinned strictly earlier SHALL be reported `invalid-output`. `capacityPredecessorIds` SHALL be the joint window's blocking set — accumulated across rounds and pools — **filtered to the reservations that finish at or before the accepted start**, because that set is a conservative scan that records reservations which may legally continue alongside the placed slice, and promoting such an overlap into the backward graph gives it a late finish before its early finish and exposes negative public float; the same filter SHALL be applied to each binding pool's candidate set before `capacityTeamId` is chosen as the pool holding the latest valid finisher, ties by pool id, and to the resource-successor edges. `capacityPredecessorIds` SHALL be empty and `capacityTeamId` null whenever `boundBy` is not `capacity`. For a `capacity` floor, `resourcePredecessorId` SHALL be selected **only from the filtered capacity blockers of the pool `capacityTeamId` names**, with ties broken by placement order within that pool, and SHALL NOT be selected from the union across binding pools: when two pools' latest valid finishers tie, a union-wide tie-break can emit an arrow from a pool other than the team the sentence names, splitting the arrow from its explanation. Fast selects from `capacityTeamBlockers` for exactly this reason (`libs/domain/src/schedule.ts:1283-1288` for the rule, `1311-1334` for the selection loop it constrains). The order handed to `lateTimes` SHALL be a **topological** order of the augmented graph rather than the chronological replay order, because an explicit zero duration is legal and lets a predecessor and its successor share a start where the id tie-break can order them backwards; that order SHALL be deterministic, derived from the hashed input, and the same for Fast. `annotate` SHALL derive the resource-successor edges `lateTimes` consumes from those ledgers, so that every `ScheduledSlice` field the read payload exposes — duration, estimate state, earliest and latest times, float, critical, `boundBy`, `resourcePredecessorId`, `capacityPredecessorIds`, `capacityTeamId`, `width`, `effort` — and both wait counters and the work-item projections are produced by the same code path that produces them for Fast, with resource edges and late times derived from the optimized placement. The floor precedence SHALL be the complete ordered list `projectStart | predecessor | stepOrder | notBefore | person | capacity | optimizer`. A start SHALL be reported as the added `ScheduleFloor` member `optimizer` only when it is strictly later than **every** floor including the person and capacity floors; a slice that starts later because its assignee or its team is occupied SHALL retain that explanation rather than being labelled `optimizer`. An `optimizer` slice SHALL carry a null `resourcePredecessorId`, an empty `capacityPredecessorIds` and a null `capacityTeamId`. The client mirror SHALL be extended in the same change: the `ScheduleFloor` union in `apps/fe-01/src/lib/wbs-api.ts` and the exhaustive `floorWordsOf` switch in `apps/fe-01/src/components/wbs/gantt-geometry.ts`.

#### Scenario: a deliberately idled slice is named rather than misattributed

- **GIVEN** a PRI solve that idles a low-priority slice past every one of its floors so a high-priority slice can run first
- **WHEN** the result is materialised and read through the plan payload
- **THEN** that slice reports `boundBy: 'optimizer'`, a null `resourcePredecessorId`, an empty `capacityPredecessorIds` and a null `capacityTeamId`, and no other slice's floor is reported as `optimizer`

#### Scenario: a resource-bound optimized slice keeps its explanation

- **GIVEN** four optimized slices whose starts are respectively equal to a predecessor floor where the pool also has room, equal to a person floor, equal to a capacity floor, and strictly later than every floor
- **WHEN** the result is materialised and read through the plan payload
- **THEN** the first reports `boundBy: 'predecessor'` with empty capacity fields rather than `capacity` with an empty blocking set, the second reports `boundBy: 'person'` with its `resourcePredecessorId`, the third reports `boundBy: 'capacity'` with non-empty `capacityPredecessorIds` and a `capacityTeamId`, only the fourth reports `optimizer`, and both wait counters and the hover words agree with those bindings

#### Scenario: a legally overlapping reservation is not promoted to a predecessor

- **GIVEN** a pool of size 2 holding a long width-1 reservation over days 0–10 and a short width-1 reservation over days 0–5, and an optimized width-1 slice pinned at day 5
- **WHEN** the result is materialised
- **THEN** `capacityPredecessorIds` names only the reservation that finished by day 5, no resource-successor edge is added from the reservation still running, and no slice reports a latest finish earlier than its earliest finish or a negative public float

#### Scenario: the capacity arrow comes from the pool the sentence names

- **GIVEN** an optimized slice bound by capacity with two eligible binding pools whose latest valid finishers end at the same instant, and `capacityTeamId` naming one of them
- **WHEN** the result is materialised and read through the real plan read
- **THEN** `resourcePredecessorId` is selected from the capacity blockers of the pool named by `capacityTeamId` alone, with the tie broken by placement order **within that pool**, and never from the union across pools

#### Scenario: the materialised schedule is field-complete on the real read path

- **GIVEN** a stored optimized variant for a project whose plan uses assignees, sized teams and a manual floor
- **WHEN** the plan is read with Engine Optimized
- **THEN** every field the same read returns for Fast is present and non-placeholder, and float, critical, earliest and latest are recomputed against the optimized starts rather than copied from Fast

### Requirement: Solver time is exchanged in fixed-point workday units

The system SHALL NOT send whole-day integers to the solver. It SHALL compute each slice's duration exactly as Fast computes it — `ASSUMED_SLICE_WORKDAYS` when `days` is null, without dividing by width, and `days / width` otherwise, preserving genuine fractions — and SHALL express durations, manual floors, the horizon and every returned offset in integer multiples of `1 / SOLVER_QUANTUM` workdays. A duration that is not an exact multiple SHALL be rounded up to the next unit, never down, because widths outside the divisors of `SOLVER_QUANTUM` are legal and no fixed denominator makes every legal duration exact. Because every quantised duration is therefore at least its real duration and every start is an exact unit multiple, any solution feasible in the quantised model SHALL be feasible in the real domain. The solution hint and the first stage's upper bound SHALL be taken from the **quantised Fast baseline** — Fast's own placement re-run over the rounded durations through the same code path — and SHALL NOT be taken from real Fast, whose value can be unreachable in the quantised model. `MOVEMENT` SHALL be measured against those integer baseline offsets. Before storage the materialised result SHALL be scored in the real domain against real Fast's value for that variant's own primary term, and when the optimized primary is **strictly worse** — never merely "not strictly better", since an equal primary may carry a strictly better secondary term and SHALL keep the solver result — the system SHALL store Fast's own materialised schedule tagged `publication: 'quantisation-floor'` rather than reporting a failure, with all three stored `value` terms recomputed in the real domain on that Fast schedule — in fractional workdays, which SHALL NOT be required to be integers — null `stageValue` and `bound`, and `status: 'unknown'`. `quantisation-floor` SHALL NOT be written into `objectiveValues[…].status`, whose enum the codec fixes at three values. The real-domain guard, not the quantised hint alone, is what completes the no-worse-than-Fast guarantee: the quantised baseline bounds the quantised model, and real Fast's own value can be unreachable inside it — three width-5 serial slices finish at 28.8 units while their rounded durations need 30. `horizonUnits` SHALL be the serial bound `max(0, ...notBeforeUnits) + Σ durationUnits`; the zero identity is required rather than tidy, because a plan with slices and **no** manual floors is the default state of nearly every project and an unseeded `max` over an empty set has no value — `schedule.ts:2051` uses the same `Math.max(0, ...)` idiom for exactly this reason; the system SHALL reject a plan whose horizon exceeds `2^31 − 1` with failure reason `horizon-overflow` rather than spawning a process, and the re-validator SHALL reject any offset that is not a non-negative integer unit within the horizon.

#### Scenario: a width-five serial plan is solvable rather than infeasible

- **GIVEN** three serial slices each with `days = 1` and `width = 5`, so Fast's real durations are 0.2 workdays and its real makespan is 28.8 units at `SOLVER_QUANTUM = 48`
- **WHEN** the request is built and solved
- **THEN** each duration is sent as 10 units, the hint and the stage-1 bound come from the quantised baseline's 30 units and are feasible, `MOVEMENT` is defined over integer offsets, and the stored variant's primary term measured in the real domain is no worse than real Fast's — falling back to Fast's own schedule if the quantised search cannot match it

#### Scenario: a width-two one-day slice keeps its half day

- **GIVEN** a slice with `days = 1` and `width = 2`
- **WHEN** the solver request is built
- **THEN** its duration is sent as `SOLVER_QUANTUM / 2` units and the materialised schedule reports `duration` 0.5, matching Fast for the same input

#### Scenario: an unestimated wide slice is not divided

- **GIVEN** a slice with `days = null` and `width = 3`
- **WHEN** the solver request is built
- **THEN** its duration is `ASSUMED_SLICE_WORKDAYS × SOLVER_QUANTUM` units, not one third of it

### Requirement: The staged objective is an anytime algorithm with stated stage outcomes

Staged lexicographic optimization SHALL divide `budgetMs` across its three terms by the exported `STAGE_BUDGET_SPLIT`, donating an early stage's remainder to the next. A stage proved OPTIMAL SHALL fix its term as an equality; a stage ending FEASIBLE, or UNKNOWN with an incumbent, SHALL constrain its term by the inequality `term <= incumbent` and SHALL NOT fix an equality; a stage ending UNKNOWN with no incumbent SHALL stop staging, and the outcome SHALL depend on the stage: at the **first** stage nothing is publishable and the variant SHALL fail with reason `no-solution`, while at any **later** stage the previously found incumbent SHALL be published, because it is feasible for the original constraints and already satisfies every bound added so far, with `objectiveValues` reporting `{ value: <recomputed on the published offsets>, stageValue: null, bound: null, status: 'unknown' }` for that term and every later one. INFEASIBLE SHALL be reported by stage. At the **first** stage it SHALL be the typed cached state `plan-infeasible` carrying every offending work item and its effective deadline, because effective deadlines enter the model before the objective terms and are therefore present at stage 1, so the proof is a property of the user's plan and the engine worked correctly; Fast's placement of the same graph proves only that the undeadlined graph is schedulable. At any **later** stage INFEASIBLE SHALL remain `invalid-output`: every constraint a later stage adds is satisfied by the previous incumbent, so it is a contract violation rather than a plan property, and it SHALL NOT be reported as `plan-infeasible` — it carries no offending-item certificate, and stage 1 already proved a deadline-satisfying schedule exists. Because the response carries no stage, the solver SHALL NOT report a later-stage INFEASIBLE as the wire status `infeasible`, which is reserved for a proof about the submitted constraint system; it SHALL exit non-zero without emitting a response, and the coordinator SHALL record that run as `invalid-output`. One stage-status matrix in the design SHALL be the single authority driving the Python implementation, the response schema and the tests; no other text SHALL restate a stage rule. The published result SHALL be the incumbent of the last stage that produced one, and a partially staged result SHALL be cacheable. <!-- wire-fields:objective-term -->`objectiveValues` SHALL report `{ value, stageValue, bound, status }` per term, and the four fields SHALL be distinct: `value` is the term recomputed on the **published** offsets, `stageValue` is the incumbent that stage found (null when it found none), `bound` is that stage's best dual bound, and `status` is a statement about the stage rather than about the published schedule. Reporting the stage incumbent as `value` SHALL NOT be permitted, because a later stage constrained by the inequality `T ≤ stageValue` may legitimately return a strictly better `T`, and the re-validator recomputes `value` from the final offsets. The re-validator SHALL check `value ≤ stageValue` whenever both are present and SHALL reject a published value worse than the stage's own incumbent as `invalid-output`. The system SHALL NOT require either variant's objective value to beat the other variant's. Supplying the **quantised** Fast baseline as both a solution hint and an upper bound on the first stage SHALL guarantee only that the solver's primary term is no worse than quantised Fast's **within the quantised model**; it SHALL NOT be credited with the real-domain guarantee, because rounding `days / width` up can cost more than the search wins. The real requirement — each variant's own primary term, measured **in the real domain**, is not worse than the real Baseline schedule's value for that term — SHALL be enforced by the publication guard defined in the fixed-point requirement, which scores the materialised schedule before storage and substitutes Fast's own schedule under `publication: 'quantisation-floor'` when the optimized primary is **strictly worse**. The substitution predicate SHALL be "strictly worse" and SHALL NOT be "not strictly better": an equal primary may carry a strictly better secondary term and SHALL keep the solver result.

#### Scenario: a later stage times out without an incumbent of its own

- **GIVEN** a PRI solve whose priority stage ends FEASIBLE with an incumbent and whose makespan stage ends UNKNOWN with no incumbent under its short budget
- **WHEN** the run ends
- **THEN** the priority stage's incumbent is published rather than discarded, the variant is not marked `no-solution`, and `objectiveValues` reports the makespan and movement terms as `unknown`

#### Scenario: the first stage exhausts the budget without proof

- **GIVEN** a PRI solve whose priority stage ends FEASIBLE with incumbent `v` after consuming its whole stage budget
- **WHEN** the makespan stage runs
- **THEN** the model carries `PRIORITY <= v` rather than `PRIORITY = v`, and the published result is the last incumbent found

#### Scenario: a run that cannot beat Fast still publishes

- **GIVEN** an input where CP-SAT finds no placement better than Fast's on the selected primary term within the budget
- **WHEN** the run ends
- **THEN** Fast's own value is published as the variant result and the variant is not marked failed

### Requirement: A generation records the input hash it was allocated for

The durable current identity SHALL live in an `optimization_generation` table keyed **`(projectId, contractVersion)`** holding `generation`, `inputHash`, `cancelEpoch`, and `admissionState` (`open | draining`), and SHALL NOT live on the project row. Keying it by contract version is required rather than tidy: a canonicalizer change bumps `SCHEDULER_CONTRACT_VERSION` while blue and green run against one database, so a single row would let the two releases alternately increment one generation and delete each other's rows for ever. A nullable internal `project.optimizationDeletePendingAt` SHALL be the durable project-wide deletion fence. Allocation within one release's row SHALL be one transaction that reads `generation`, `inputHash`, and `admissionState`; it SHALL reject a non-`open` row or a project with `optimizationDeletePendingAt`, reuse the generation when the stored hash equals the computed hash, and otherwise set the hash and increment the generation under a compare-and-swap on the generation it read, deleting the previous generation's cache and queue rows in the same transaction. It SHALL NOT delete that generation's slot rows, which stay counted until release or expiry. Allocation SHALL define the missing-row case: a project enabling optimization for the first time, or the first appearance of a new contract version, begins with an `open` row inserted with do-nothing-on-conflict and then re-read, letting two concurrent first writers coalesce. The `optimization_generation`, `solver_slot` and `solver_queue` tables SHALL each carry a `projectId` foreign key with `ON DELETE CASCADE`, but the cascade SHALL remain a backstop and SHALL NOT remove a slot row while its child may still run.

Project deletion and contract retirement SHALL use the named `beginOptimizationDrain(projectId, contractVersion?)` and `finishOptimizationDrain(projectId, contractVersion?)` seams. Begin SHALL run in one transaction: retirement changes the targeted generation to `draining`; project deletion first sets `optimizationDeletePendingAt` and changes every generation for that project to `draining`; both paths increment the affected `cancelEpoch`, set `cancel_requested_at` on affected slot rows, and delete affected queue rows. Ordinary project reads and writes SHALL treat a delete-pending project as absent, while its physical row remains to retain slot rows and capacity accounting. Admission and dequeue SHALL both reject `draining` and delete-pending state. Slot rows SHALL then remain counted until their owner releases them or `now > admittedDeadlineAt`. Finish SHALL run in a transaction that observes the durable closed state and zero affected slot rows before it physically deletes the generation or project row. Finish SHALL NOT depend on the process that began the drain: it SHALL also be reached opportunistically, in the same transaction in which a slot release or a reclaim sweep removes the last affected row, and by a `reconcileOptimizationDrains()` pass that SHALL run on coordinator startup and periodically, scanning `draining` generations and delete-pending projects, reclaiming affected slots past their stored `admittedDeadlineAt`, and finishing those with none left. Both paths SHALL invoke the same transactional finish with the same precondition, SHALL be idempotent, SHALL be a no-op on an absent target, and SHALL be safe to run concurrently without a lock. A drain SHALL NOT reopen admission under any path, and a coordinator crash between begin and finish SHALL NOT leave a project permanently hidden with admission closed. A 30-day untouched generation or a deploy-retired contract version SHALL enter this same drain path rather than be deleted immediately. This durable state prevents another coordinator from admitting between a zero-slot observation and the final delete. The observed count of real solver processes SHALL NOT exceed 4 per project or 16 globally at any instant during either path. Two processes computing the same hash concurrently SHALL NOT allocate two generations, and a process computing a different hash SHALL NOT coalesce onto the current generation's slot.

#### Scenario: a project enabling optimization for the first time

- **GIVEN** a project with no `optimization_generation` row and two concurrent edits under one contract version
- **WHEN** both allocate
- **THEN** exactly one row exists, both observe the same generation, and one child per objective is spawned

#### Scenario: deleting a project drains its slots before releasing their budget

- **GIVEN** a project holding an admitted solver slot whose child is still running, and a queued entry
- **WHEN** the project is deleted
- **THEN** admission for that project closes, its cancel epoch advances, its queue rows are deleted and its slot row is marked `cancel_requested_at` **without being deleted**, so the slot stays counted while the child is alive
- **AND WHEN** that child exits and its owner releases the slot, or `now > admittedDeadlineAt`
- **THEN** the generation, slot, queue and cache rows are gone and the global slot count reflects the release
- **AND** the observed number of real solver processes never exceeds 16 at any point in the sequence

#### Scenario: retiring a contract version drains before deleting

- **GIVEN** two contract versions live against one database, the retiring one holding an admitted slot with a running child
- **WHEN** that contract version is retired
- **THEN** its rows are removed only after its slot rows are released or reach their stored deadline, and the surviving contract version's rows and slot budget are untouched throughout

#### Scenario: another coordinator cannot reopen a drain race

- **GIVEN** blue has committed `admissionState='draining'` for a contract and observed its affected slot count reach zero
- **WHEN** green attempts both direct admission and dequeue before blue calls `finishOptimizationDrain`
- **THEN** both attempts are rejected by the durable state, no child starts, and blue's final transactional zero-slot check deletes no live slot

#### Scenario: two canonicalizers do not supersede each other

- **GIVEN** an outgoing release computing hash H1 and an incoming release computing H2 for the same unchanged stored plan
- **WHEN** both read the project repeatedly
- **THEN** each converges on its own `(projectId, contractVersion)` row and neither reallocates a generation or deletes the other's rows, while a real plan edit still changes both hashes and fences both releases' in-flight work

#### Scenario: two backends cold-read the same plan at once

- **GIVEN** blue and green both compute hash H for a project whose stored hash is H0
- **WHEN** both attempt allocation
- **THEN** exactly one increments the generation and stores H, the other observes H and reuses the same generation, and one PRI child and one Time child exist in total

#### Scenario: a restart on an unchanged plan reuses its generation

- **GIVEN** a backend restarts while the project's stored hash still equals the computed hash
- **WHEN** the plan is read
- **THEN** no new generation is allocated and the existing cache rows remain valid

### Requirement: A failed variant reaches a client already on screen

A newly written failure marker SHALL emit a `schedule_optimization_failed` project event in the same transaction that writes the row, carrying `(projectId, generation, inputHash, objective, contractVersion, budgetMs, failureReason)` and no schedule. A client displaying that variant SHALL move to the `Optimization unavailable · Retry` indicator on receiving it, without a manual refresh and without refetching the variant. A cache hit SHALL still emit nothing.

#### Scenario: both variants fail and Retry still appears

- **GIVEN** a client viewing Engine Optimized while both PRI and Time solves are in flight
- **WHEN** both fail and no other event occurs
- **THEN** the client shows `Optimization unavailable · Retry` for the selected variant without any refresh or poll

### Requirement: Result events name every cache-key dimension

Both `schedule_optimized` and `schedule_optimization_failed` SHALL carry `budgetMs` in their identity, so a receiver can tell which cached row an event names. The system SHALL guarantee one durable `event_log` record per newly stored outcome plus one best-effort post-commit push, and SHALL NOT claim delivery over a live socket. The record SHALL be written inside the same transaction as its cache row through a transaction-taking repository call, and pushed afterwards without being recorded twice.

#### Scenario: raising the budget notifies a client holding the old result

- **GIVEN** a client holding the stored result for generation G at budget 60000
- **WHEN** the budget is raised to 120000 and a new result is stored for the same hash and generation
- **THEN** the event's identity differs by `budgetMs` and the client refetches rather than ignoring it as a duplicate

#### Scenario: the process dies between commit and push

- **GIVEN** a stored result whose transaction has committed
- **WHEN** the process exits before the websocket push
- **THEN** the `event_log` record exists and a client resuming from its last sequence receives it

### Requirement: The canonical slice order is stable across reads and processes

Canonicalization SHALL group slices by work item, order the groups by work-item id, and preserve each group's own order as given, because only the intra-item order carries step precedence. Canonicalization alone SHALL be what makes the hash stable: `WorkItemRepo.listByProject` SHALL NOT acquire an `ORDER BY` in this change, and the scenario below SHALL hold over whatever row order SQL returns. An ordered read is a separate change with its own response-order contract and index — **TASK-260** — because adding one here would move the dates of an existing project whose siblings share a position and a one-slot team, which this change is not entitled to do.

#### Scenario: an unchanged project hashes identically across adapter reads

- **GIVEN** a stored project read twice through the production repository and service path
- **WHEN** the two canonical inputs are hashed
- **THEN** the hashes are equal even if the underlying row order differs

### Requirement: Every new stored enum is validated at the read boundary

The migrations SHALL declare a `CHECK` for each new enum stored in its own scalar column, table by table. On the cache row those are `status`, the cache's `objective` and `failureReason`. On the `project` row they are `schedule_engine` and `schedule_objective`. Elsewhere: `admissionState`; `solver_slot.lifecycle`; and — because a stored enum is a column and not a type, so one validated column does not cover its siblings — `solver_slot.objective` and `solver_queue.objective`, both of which are the same `'pri' | 'time'` enum in their own scalar column and in their table's primary key. A `CHECK` is required for the new boolean column too, and the repository read paths SHALL validate those scalar values explicitly, throwing an error naming the column and stored value on an unknown one, as `toProject` already does for `estimateMethod`, `depReach` and `estimateRounding`. Enums inside opaque `resultJson` (`publication` and per-term `status`) SHALL have codec validation only and SHALL NOT have a JSON-validity or JSON-extraction database `CHECK`. The system SHALL NOT cast or default an unknown stored enum.

#### Scenario: an unknown failure reason is refused rather than defaulted

- **GIVEN** a cache row whose `failure_reason` holds a value outside the defined set
- **WHEN** the row is read on the production path
- **THEN** the read throws naming the column and the value, and no variant state is inferred from it

### Requirement: The solver package is installed in the deployed image

The build SHALL install the pinned Python runtime and the locked OR-Tools environment into the be-01 image, copy the `wbs-solver` package and **both its console scripts** — the solve entrypoint and `wbs-solver-launcher` — into that runtime, and expose the installed package version to the coordinator as the `solverVersion` half of `contractVersion`. The Python suite SHALL have its own build target wired into the gate.

#### Scenario: a spawn from the built image succeeds and its absence is proved to fail

- **GIVEN** the built be-01 image
- **WHEN** the coordinator spawns the solver entrypoint
- **THEN** it returns a valid response line, and an image built without the package makes the same spawn fail with `internal-error` rather than silently returning Fast

#### Scenario: the production launcher path is proved from the image, not only the solve entrypoint

- **GIVEN** the built be-01 image and task 5.11's install proof
- **WHEN** the coordinator spawns `wbs-solver-launcher` as production does
- **THEN** the launcher is present and reaches `bound` then `exec`, and an image carrying the solve entrypoint but **not** the launcher fails this proof even though the entrypoint smoke test above still passes

### Requirement: The comparison indicator names the change by an exact order relation

Two schedules SHALL be reported as the same order iff, for every pair of slices present in both, the sign of the difference between their starts is equal in both, compared in the real fractional-workday domain on the two materialised schedules rather than in quantised units, because real Fast's starts need not lie on the unit grid and quantised comparison would report a reorder produced purely by rounding. The relation SHALL be computed server-side and shipped as one boolean beside the day-count delta.

#### Scenario: a uniform shift is not a reorder

- **GIVEN** an optimized schedule whose every slice starts exactly two workdays later than Fast's
- **THEN** the indicator reports the same order and a later deadline

#### Scenario: a broken tie is a reorder

- **GIVEN** two slices that start on the same day under Fast and on different days under the optimized result
- **THEN** the indicator reports reordered

### Requirement: Cancellation is a durable epoch observed across processes

Turning the optimization toggle OFF SHALL advance a durable `cancelEpoch` for every contract version of that project and SHALL NOT advance the generation, because the toggle is deliberately excluded from the input hash and allocation is required to reuse the generation for an unchanged hash. The OFF transition SHALL, in one transaction, clear `optimization_enabled`, increment the epoch, set `cancel_requested_at` on every one of that project's `solver_slot` rows, and delete its queue rows. A solver owner SHALL read `cancel_requested_at` and the current epoch on the same round trip as its heartbeat and SHALL terminate its child when either has moved, so real termination is bounded by one heartbeat interval even when the child belongs to a different backend process. A local process handle SHALL NOT be the cancellation mechanism.

#### Scenario: one backend turns the toggle off while the other owns the children

- **GIVEN** blue owning a live PRI child and a live Time child for a project, and green serving the settings PATCH
- **WHEN** green turns optimization OFF
- **THEN** both real children exit within one heartbeat interval, and neither can store a result, write a failure marker, or emit any event, because every write is conditional on the epoch and on `optimization_enabled`

### Requirement: The plan read carries every optimization state the UI renders

The plan read SHALL return an `optimization` block beside the existing schedule arrays and wait counts. It carries `enabled`, `engine`, `objective`, `inputHash`, `generation`, `contractVersion`, `budgetMs`, `displayed`, a `variants` map with one state per objective, and a `comparison` present exactly when `displayed` is not `fast`. Each variant state SHALL be one of `ready`, `pending`, `retrying`, `failed` with its reason, `corrupt` with the decoder's message, `plan-infeasible` with the offending work items and their **effective** deadlines, or `idle`, distinguished by the presence of a cache row together with the presence of a live slot or queue entry for that key. `corrupt` SHALL render the same non-intrusive `Optimization unavailable · Retry` control as `failed`. `plan-infeasible` SHALL NOT render that control and SHALL read `Plan infeasible · N work item deadlines` with the offending items available on demand, because the answer is a deterministic function of the input and a Retry affordance would promise a different one; each listed entry SHALL name both the work item that owns the binding date and the work item the constraint fell on, which are the same id when a leaf's own date binds. The schedule arrays SHALL hold Fast when the toggle is OFF, when Engine is Fast, or when the selected variant is not `ready`, and otherwise the materialised selected variant, with `displayed` naming which. A freshly loaded client SHALL be able to render every state from this one response without a second request.

#### Scenario: a cold reload distinguishes pending from failed

- **GIVEN** a project whose PRI variant has a failure marker with no live slot entry and whose Time variant has a live slot entry and no row
- **WHEN** a client loads the plan for the first time
- **THEN** the response reports PRI `failed` with its reason and Time `pending`, the arrays hold Fast, and the client renders Retry for PRI and `Optimizing…` for Time without polling

#### Scenario: a retry in flight is not rendered as unavailable

- **GIVEN** a failed PRI variant whose Retry has been admitted and whose marker row still exists
- **WHEN** the plan is read
- **THEN** PRI reports `retrying` rather than `failed`, Fast stays on screen, and no read deletes the marker or starts a second child

### Requirement: Retry is an authorized endpoint with defined stale and concurrent responses

Retry SHALL be `POST /api/projects/:projectId/optimization/retry` with a body naming the `objective` and the `inputHash` the client holds, under the same project-write authorization as the settings PATCH. It SHALL run the ordinary admission transaction, so two concurrent retries produce one child. It SHALL evaluate its response in **exactly this order**, because the earlier ordering was ambiguous for `pending` (kimi r10 Important 2): (1) if the body's `inputHash` is not current, `409 stale-input-hash` carrying the current hash; (2) otherwise, if the variant's current row is neither `failed` nor `corrupt` — which covers `ready`, `pending`, `idle` and `plan-infeasible`, since `pending` has **no row at all** and a `plan-infeasible` row is a proved deterministic answer that re-solving the same input cannot change — `409 not-retryable` naming the state; (3) otherwise, if a live slot or queue entry exists for the full cache key including `budgetMs`, `409 already-running`, which is the `retrying` state and the double-posted-Retry case; (4) otherwise admit through the ordinary admission transaction and answer `202` with the new state, generation and input hash. Retryability SHALL be evaluated **before** the live-entry check; the reverse order answered `already-running` for `pending`, whose definition guarantees a live entry, contradicting the requirement that a `pending` variant is not retryable. It SHALL accept a variant whose current row is `failed` **or** `corrupt`, because a corrupt row is a `status='ok'` row and an explicit Retry is the only recovery path the codec requirement offers it. `already-running` SHALL be evaluated against the full cache key including `budgetMs`. It SHALL NOT delete the failure marker or the corrupt row before its replacement outcome commits, and SHALL then overwrite it exactly once.

#### Scenario: a retry against a superseded plan is refused with the current hash

- **GIVEN** a client holding a failed variant for hash A while the project has since moved to hash B
- **WHEN** it posts a retry naming hash A
- **THEN** the response is `409 stale-input-hash` carrying hash B, no process starts, and the client refetches rather than retrying blind

#### Scenario: concurrent retries of a corrupt row coalesce and overwrite once

- **GIVEN** a variant whose cache row is `corrupt` and two collaborators posting Retry for it at the same time
- **WHEN** both requests are handled
- **THEN** exactly one solver child starts, both responses report `retrying`, the corrupt row is still present while the child runs, and it is replaced exactly once when the outcome commits

#### Scenario: a retry against a non-retryable variant names the state

- **GIVEN** a variant that is `ready`
- **WHEN** a client posts Retry for it
- **THEN** the response is `409 not-retryable` naming `ready`, and no process starts

### Requirement: The cached schedule has a versioned codec

The stored column SHALL be `resultJson`, holding a versioned `OptimizedResult` — `{ dtoVersion, publication, objectiveValues, schedule }` where `publication` is `'solver' | 'quantisation-floor'` and each `objectiveValues` entry is a `StoredObjectiveValue` — `{ value: number, stageValue: number | null, bound: number | null, status: 'optimal' | 'feasible' | 'unknown' }`. The numeric domain of the stored terms SHALL be determined by `publication` and SHALL be validated per domain. For `publication: 'solver'` every non-null objective number SHALL be in quantised solver units and SHALL be a non-negative safe integer; an unsafe value SHALL fail decoding rather than lose precision. For `publication: 'quantisation-floor'` every `value` SHALL be the real-domain term in fractional workdays and SHALL be a finite non-negative number that need not be an integer; `NaN`, infinities and negative values SHALL fail decoding, and the safe-integer check SHALL NOT be applied — real durations are `days / width` and the required width-five floor row's makespan is 0.6 workdays, so a blanket safe-integer rule would reject the row the publication guard is required to store. The wire schema SHALL be unchanged and SHALL keep requiring non-negative safe integers. A real-domain term SHALL be compared only against another term produced by the same real-domain scorer accumulating over slices in canonical order, using exact `number` comparison with no epsilon, and SHALL NOT be compared against a quantised term. `quantisation-floor` SHALL appear only in `publication` and SHALL NOT be an `ObjectiveValue.status`, since the stage-status matrix that generates the wire schema and the read validator fixes that enum at three values. `publication` and each per-term `status` SHALL NOT be constrained by a database `CHECK`, because both live inside `resultJson`; `decodeOptimizedResult` SHALL be their sole validator, rejecting an unknown `publication` and an unknown per-term `status` by name. Database `CHECK`s SHALL cover the scalar columns only. No `CHECK` SHALL require `resultJson` to be valid JSON, because a malformed payload SHALL remain storable so a read can surface it as `corrupt`. For a `quantisation-floor` row every `value` SHALL be recomputed in the real domain on the stored Fast schedule, `stageValue` and `bound` SHALL be null, `status` SHALL be `unknown`, and the `value` ≤ `stageValue` relation SHALL NOT be checked, because it is a within-stage relation with no meaning across the quantised and real domains — rather than a bare schedule, because `Schedule` carries neither the per-term values that record how far a partially staged run got nor the quantisation-floor publication state, and without them a cache hit cannot distinguish a proved result from a partial one or from Fast's own schedule republished under the floor guard. Its `schedule` member SHALL be a versioned DTO with explicit `encodeSchedule` and `decodeSchedule` functions rather than an unspecified serialisation, because `Schedule` carries two `Map` values that `JSON.stringify` renders as empty objects. Both maps SHALL be encoded as arrays of entries sorted by key, and `waitingForPerson`, `waitingForCapacity` and `eventsVisited` SHALL be stored so the round trip is total. `decodeSchedule` SHALL reject an unknown `dtoVersion`, a duplicate key, an entry whose key disagrees with its own slice key, or a missing work-item projection, throwing and naming the defect rather than returning a partial plan. A row that fails to decode SHALL be left in place and SHALL NOT be deleted or treated as a cache miss: it SHALL read as the variant state `corrupt` carrying the decoder's message, SHALL never satisfy a read, and SHALL never trigger an automatic solve, because silently deleting it converts corruption into the read-triggered retry the design forbids. An explicit Retry SHALL overwrite it through the ordinary admission path.

#### Scenario: a partially staged result keeps its objective metadata

- **GIVEN** a stored variant whose last stage ended UNKNOWN without an incumbent, and a second stored variant published under the quantisation floor
- **WHEN** each row is read back from SQLite through the plan read
- **THEN** the first reports `status: 'unknown'` for that term with its earlier terms intact, the second reports `publication: 'quantisation-floor'` with a `status` inside the three-value enum, null `stageValue` and `bound`, and `value` equal to the real-domain term recomputed on the stored Fast schedule, and neither is presented as a proved solver win

#### Scenario: a fractional real-domain floor value survives storage and reload

- **GIVEN** the width-five three-slice serial fixture, whose real Fast makespan is 0.6 workdays — 28.8 solver units — and is therefore not an integer in either unit
- **WHEN** its `quantisation-floor` row is written and read back through SQLite and the real plan read
- **THEN** decoding accepts the fractional `value`, the reloaded number is bit-equal to the real-domain scorer re-run on the reloaded Fast schedule, `stageValue` and `bound` are null, and the same decoder rejects a `publication: 'solver'` row carrying that identical non-integer value as unsafe

#### Scenario: a corrupt cached row is surfaced rather than deleted

- **GIVEN** a cache row whose `resultJson` is truncated
- **WHEN** the plan is read ten times by three collaborators
- **THEN** the row still exists, every read reports that variant as `corrupt` with the decoder's message, no solver process is spawned, and one explicit Retry produces exactly one child

#### Scenario: a stored schedule reloads non-empty through the real read path

- **GIVEN** a materialised optimized schedule with populated slice and work-item maps
- **WHEN** it is stored, read back from SQLite and returned through the plan read
- **THEN** every slice and work-item entry is present with its fields, and a row whose JSON has a duplicate or mismatched key is refused rather than served as a partial plan

### Requirement: An empty project bypasses the solver entirely

A project with no slices, or one whose slices all carry a zero duration, SHALL NOT be sent to a solver. `MAKESPAN`, defined as the maximum finish, has no empty-set identity, while `schedule` handles the empty plan explicitly and returns an empty schedule with a project finish of zero. `horizonUnits` SHALL NOT be cited as a second reason: its `notBeforeUnits` max is seeded with zero and is therefore defined for every plan. The coordinator SHALL therefore short-circuit: no slot is allocated, no process is spawned, no cache row is written and no event is emitted, and the plan read SHALL return Fast with every variant reported `idle`.

#### Scenario: optimization ON with no work items

- **GIVEN** a project with optimization enabled and zero work items
- **WHEN** the plan is read cold
- **THEN** no solver process is spawned, no cache row and no event exist, and the payload renders with every variant `idle`

#### Scenario: deleting the last work item leaves no stale row

- **GIVEN** a project with one work item and a stored optimized pair
- **WHEN** that work item is deleted and the plan is read
- **THEN** the new canonical input is empty, no solver runs, and the read reports every variant `idle` rather than serving the previous generation's rows
