# Verification Report

> Filled in by the implementing agent with the evidence it produced locally. The
> h2puni gate rows are deliberately left pending: that gate takes the canonical
> host-wide lock and belongs to the controller.

**Change**: `fifo-heavy-lock`
**Verified at**: `2026-09-16`
**Verifier**: implementing agent (W2), local worktree `/home/df/wd/puni/wbs-tool-v1-w2`

---

## 1. Structural Validation

- [x] `bunx @fission-ai/openspec@1.3.0 validate --all --json` — all items `"valid": true`

```
      "id": "fifo-heavy-lock",
      "type": "change",
      "valid": true,
      "issues": [],
      "durationMs": 1
    "totals": { "items": 84, "passed": 84, "failed": 0 }
```

| Item              | Type   | Issues |
| ----------------- | ------ | ------ |
| `fifo-heavy-lock` | change | none   |

---

## 2. Task Completion

- [ ] Every `- [ ]` in tasks.md is now `- [x]` — 7.1 stays open for its last clause, the rollout drain check

| Task                    | Reason incomplete                                                                                                                                                 | Blocks archive? |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 7.1 rollout drain check | Everything else in 7.1 is done: the gate is green on `5f9551b8` and this file records it. The drain check belongs to whoever runs the first post-merge heavy run. | No              |

---

## 3. Delta Spec Sync

| Capability         | Sync status | Note                                                   |
| ------------------ | ----------- | ------------------------------------------------------ |
| `heavy-lock-queue` | ✗ pending   | New capability; syncs to `openspec/specs/` at archive. |

---

## 4. Failure Proofs

> Every row was watched failing with the fault injected on the production call
> path, and the same fault and output are recorded in the `Proof:` comment beside
> the check. Faults were reverted from a byte copy and the suite re-run green.

| Check (file:line)                                        | Fault injected                                         | Test that observed the failure | Result                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heavy-lock-lib.sh` arrival-order branch                 | `if [[ $tickets_ahead -eq 0 ]]` → `if true`            | heavy-lock case 8              | `want 'a b ', got 'b a '`                                                                                                                                                                                                                      |
| `remove_dead_tickets` dead-pid reclaim                   | reclaim body → `:`                                     | heavy-lock case 9              | `9a … want exit 0, got 75`; stderr `is held by pid ?`                                                                                                                                                                                          |
| `remove_dead_tickets` budget expiry                      | branch absent (pre-fix code)                           | heavy-lock case 17a–c          | `17a … want exit 0, got 75`; ticket from a live pid kept the queue                                                                                                                                                                             |
| `remove_dead_tickets` draft sweep                        | loop absent (pre-fix code)                             | heavy-lock case 23             | `23b: the draft from a dead pid was left behind for ever`                                                                                                                                                                                      |
| `prepare_ticket_queue` readability                       | both conditions → `false`                              | heavy-lock cases 10a–10d       | claimed ahead of a live ticket, marker written, exit 0; mode-500 → exit 1                                                                                                                                                                      |
| `prepare_ticket_queue` creation                          | first refusal → `false`                                | heavy-lock case 15b            | 10 checks failed, every diagnosis naming the wrong thing                                                                                                                                                                                       |
| `read_ticket_pid` name check                             | condition → `false`                                    | heavy-lock case 12             | `removing ticket note from dead pid note`, file deleted, exit 0                                                                                                                                                                                |
| `read_ticket_deadline` epoch check                       | missing deadline defaulted to `0`                      | heavy-lock cases 17d–17e       | `17d … want exit 70, got 0`; deleted a ticket it could not read                                                                                                                                                                                |
| `read_ticket_label` / `read_ticket_deadline` vanish (66) | `-r` test in front of the read (pre-fix)               | heavy-lock case 21             | `21a … want exit 0, got 70`, `21b … want exit 0, got 70`                                                                                                                                                                                       |
| `read_epoch_nanoseconds` 19-digit check                  | drop it; then drop the name check too                  | heavy-lock case 14             | wrong diagnosis; then `14b: it ran on a ticket it could not order`, exit 0                                                                                                                                                                     |
| `report_heavy_lock_status` lock-dir read                 | condition → `false`                                    | heavy-lock case 13a            | `holder pid  label `, exit 0 for a mode-000 lock directory                                                                                                                                                                                     |
| `report_heavy_lock_status` absent vs unreadable          | absent read as unreadable (pre-fix); then `-r`→`false` | heavy-lock cases 18a–18f       | `18a/18c … want exit 0, got 70`; then `cat: … Permission denied`, exit 1                                                                                                                                                                       |
| `report_heavy_lock_status` queue read                    | condition → `false`                                    | heavy-lock case 13d            | holder printed, no waiters, exit 0 over a mode-000 queue holding two tickets                                                                                                                                                                   |
| `read_ticket_label` ticket guards                        | both refusals → `unlabeled` default                    | heavy-lock cases 13b–13c       | `waiter pid 999999 label unlabeled age …`, exit 0                                                                                                                                                                                              |
| claim-time ticket delete                                 | line removed                                           | heavy-lock case 16e            | `tickets while held: 1 -> …-1922461` — the holder queued behind itself                                                                                                                                                                         |
| waiting trap ticket removal                              | `true` in place of the removal                         | heavy-lock case 16d            | `16d: a refused run left 1 ticket(s) in the queue`                                                                                                                                                                                             |
| `install_release_trap` caller chaining                   | plain `trap … EXIT` (pre-fix)                          | gate case 33                   | `a gate refused while queued leaked its trusted-launcher directory`                                                                                                                                                                            |
| `release_heavy_lock` isolation                           | unisolated `rm; rm; eval` list                         | heavy-lock case 22             | `22a … want exit 42, got 1`; caller trap skipped; nothing said                                                                                                                                                                                 |
| deadline refusal names the queue                         | unconditional holder line (pre-fix)                    | heavy-lock case 20b            | `heavy lock: …bash.d is held by pid ?` about a free lock                                                                                                                                                                                       |
| `describe_tickets_ahead` unknown vs gone                 | single `gone` (pre-fix)                                | heavy-lock case 20d            | `behind 1 tickets: gone (pid 2404329)` for a ticket still in front                                                                                                                                                                             |
| ticket published by `mv`                                 | redirect-only publish (pre-fix)                        | heavy-lock case 19d            | `19d: the ticket is not published by rename`                                                                                                                                                                                                   |
| `claim_heavy_lock` holder read-first                     | pre-fix order: `-r` test, then `cat`                   | heavy-lock case 24             | `24a … want exit 0, got 70` (a released lock called corrupt); `24c … want exit 75, got 70`; also observed unforced as `3a … want exit 0, got 70`                                                                                               |
| `report_heavy_lock_status` holder read-first             | pre-fix order: test, then `cat`                        | heavy-lock case 25             | `25a … want exit 0, got 1`, `cat: …/holder: No such file or directory`                                                                                                                                                                         |
| `HEAVY_LOCK_POLL_SECONDS` validation                     | check absent; then the bound written without `10#`     | heavy-lock case 26             | `abc` and `300` accepted in silence — `26a`, `26c … want exit 64, got 0`; then `031` (read as octal 25, then slept 31) and `08` (`((: 08: value too great for base`) — `26e`, `26f … want exit 64, got 0`; `0` accepted as a busy spin — `26h` |
| `report_heavy_lock_status` released-lock branch          | branch → `false`                                       | heavy-lock case 25d            | `no line 'heavy lock: holder none' in: heavy lock: holder claiming` — a lock nobody holds reported as one being claimed                                                                                                                        |
| `report_heavy_lock_status` empty holder file             | `-z $holder_pid` half absent                           | heavy-lock case 25f            | `heavy lock: holder pid  label held` — a holder with no pid, at the instant `claim_heavy_lock` answers 75                                                                                                                                      |
| `install_release_trap` INT/TERM exit                     | release-only handler (shipped)                         | heavy-lock case 27             | `27a … want exit 143, got 0`, `27b: it took 5s to leave`, `27d: the signalled waiter claimed the lock after it was told to stop` — observed live on h2puni first (pid 4049358)                                                                 |
| `install_release_trap` EXIT cleared in the handler       | `trap - EXIT` absent                                   | heavy-lock case 27j            | `the caller's own EXIT trap ran 2 times`                                                                                                                                                                                                       |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [x] Where code distinguishes filesystem state, both absence AND unreadability
      were tested (cases 18a–18f for the lock directory, 21 vs 13b–13c for tickets)
- [x] No row relies on an exit code unless the tool's contract guarantees the
      effect — every row above pairs its status with observed output or an
      observed filesystem state

---

## 5. Gate Output

- [x] `bash bin/heavy-lock.test.sh` (×2 on the final commit, ×21 over the change)
- [x] `bash bin/h2puni-gate.test.sh`
- [x] `shellcheck bin/heavy-lock-lib.sh bin/with-heavy-lock.sh bin/h2puni-gate.sh bin/heavy-lock.test.sh bin/h2puni-gate.test.sh`
- [x] `bunx nx test tool-dagger --skip-nx-cache`
- [x] `bunx nx format:check --all`, `git diff --check`
- [x] `bin/h2puni-gate.sh 5f9551b8` on h2puni — exit 0
- [x] `bunx nx run-many -t test lint typecheck build` — inside that gate

```
all heavy-lock checks passed          (96 ok, exit 0, consecutive runs)
all cases passed                      (bin/h2puni-gate.test.sh, 85 ok, exit 0)
shellcheck: exit 0, no output         (all five scripts)
62 pass, 0 fail                       (tool-dagger, --skip-nx-cache)
format:check --all: exit 0            git diff --check: exit 0
```

The h2puni gate, run by the controller on `5f9551b8`
(log `~/gate-5f9551b8.log`, `~/gate-5f9551b8.exit` = 0):

```
h2puni gate: running on 5f9551b83d4777d1dbbb476c3047ec1767a81a93
openspec 84 valid; format:check clean
Successfully ran targets test, lint, typecheck, build for 31 projects
Successfully ran targets test, typecheck for project tool-wiki
Successfully ran target lint:source for project tool-wiki
Successfully ran target solver-image-smoke for project wbs-be-01
```

### The queue in production (task 2.3's observed evidence)

Earlier the same day, the gate for `010cabe3` queued behind the gate for `348f7fb7` and reported
its wait as its FIRST line, before the head it was gating:

```
heavy lock: waited 372s behind 0 tickets
h2puni gate: running on 010cabe3…
```

and `bin/with-heavy-lock.sh status` on h2puni, with three lanes live:

```
heavy lock: holder pid 2998238 label gate:010cabe3
heavy lock: waiter pid 3291912 label gate:5fc1a304 age 1297s budget 503s left
heavy lock: waiter pid 3417020 label gate:218e890d age 1070s budget 730s left
```

That is the whole change working on the host it was written for: arrival order, the lane labels
naming which commit holds the box, and each waiter's remaining budget. It also produced the first
operational finding the queue makes visible at all — **the 1800-second default budget in
`bin/h2puni-gate.sh` cannot cover a second waiter behind a full gate**. Both waiters above expired
before their turn. Queued in `docs/refactoring/tasks.md`; it is a budget, not a correctness defect,
and raising it is a one-line change that deserves its own evidence.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree
- [ ] Relevant commits pushed — branch is local; the controller integrates

**Commit range**: `73730b66..5f9551b8` on `change/fifo-heavy-lock` — the range the h2puni gate
above ran on. The commit that adds this section is documentation plus one line in
`bin/heavy-lock.test.sh` (a `grep -c` fallback that produced `0\n0` on the red path), and is gated
again rather than claimed under `5f9551b8`'s result.

---

## Rollout

**Drain the queue before the first post-merge heavy run on h2puni.** A ticket
written by pre-fix code has no `deadline` line, and `read_ticket_deadline`
refuses it: every new run exits 70 naming that ticket until its owner leaves.
The owner does leave on its own — the old code removes its ticket on claim, on
refusal and on EXIT — so this is a window, not a wedge, but the window is as long
as whatever heavy run is queued.

Before the first run at the new head, check `bin/with-heavy-lock.sh status`:

- `heavy lock: holder none` with no `waiter` lines — safe to proceed.
- Any `waiter` line — that is a pre-fix waiter; let it finish, or remove its
  ticket by hand if its pid is gone.

The reverse direction needs nothing: a post-fix ticket carries an extra line that
pre-fix code never reads.

---

## Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — the h2puni gate is green on `5f9551b8` and every
      safety check has a watched negative. Four things are still worth a reader's
      attention: 1. bash 3.2 and the Darwin `python3` clock fallback are unexercised —
      `/bin/bash` here is 5.2.21, so the suite's second pass is skipped, and
      `trap -p`, `${var#trap -- }` and the `cat`/`sed` status classification
      are 3.2-safe by documentation rather than by observation. 2. INT is a no-op for a run started asynchronously without job control
      (`nohup … &`), because such a shell inherits SIGINT ignored and an
      ignored signal cannot be trapped. TERM works everywhere and is what
      automation should send; case 27h documents the measurement. 3. The 1800-second default budget in `bin/h2puni-gate.sh` is too short for
      a second waiter behind a full gate — observed above, two waiters
      expired. Queued, not fixed here. 4. The rollout drain check below has to happen before the first post-merge
      heavy run.
- [ ] ❌ FAIL

**Next step**:

The controller integrates. The only step left before the first post-merge heavy
run is the Rollout drain check above, which belongs to whoever is at the host.
