Ordered slices for `bin/heavy-lock-lib.sh` and its two callers. Every safety check below names the
fault injected to watch its negative fail; the observed output belongs in the `Proof:` comment
beside the check, per AGENTS.md R5. Case numbers are `bin/heavy-lock.test.sh`'s unless said
otherwise.

## 1. Serve waiters in arrival order

- [x] 1.1 Enqueue a ticket per waiting run under `<lock path>.queue`, claim only as the oldest
      live ticket, delete the ticket on claim and on EXIT/INT/TERM, and add
      `HEAVY_LOCK_POLL_SECONDS` (default 5) — test: case 8 runs a holder, waiter A, then waiter B
      with a one-second poll, and asserts A's command ran first; watched failing as `b a` against
      the poll-first lottery, before the queue existed and again with the arrival-order branch
      restored to `if true`.
- [x] 1.2 Remove a ticket whose pid is gone, naming it on stderr — test: case 9 plants a ticket
      from an exited pid and asserts the next run takes the lock; negative: with the reclaim
      skipped the run is refused 75 behind a process that will never release.
- [x] 1.3 Refuse exit 70 when the queue directory cannot be created, read or written — test: case
      10 runs against a mode-300 queue, case 15 against a queue path that is a plain file. Mode
      300, not 000: a queue that cannot be WRITTEN fails at the ticket redirect, so only a
      write-only queue reaches the state this guard is about — the glob sees nothing, the run
      reads an empty queue and claims over the older live ticket in it. Negative for 10: with both
      conditions removed the run claimed ahead of a live ticket and wrote its marker.
- [x] 1.4 Refuse exit 70 for a queued name that is not `<nanoseconds>-<pid>` (case 12) and for a
      host with no nanosecond clock (case 14) — negatives: with the name check removed the run
      treats a stray file as a ticket from a dead pid and deletes it; with the clock check removed
      as well it enqueues `1758012345N-<pid>` and runs.
- [x] 1.5 Report the queue: `report_heavy_lock_status` behind `bin/with-heavy-lock.sh status`, and
      `heavy lock: waited <n>s behind <k> tickets` on every claim — test: case 11 asserts holder
      then two waiters oldest first; case 13 asserts exit 70 on an unreadable lock directory,
      queue directory and ticket; negative: with the readability guard removed status reports a
      holder with an empty pid.

## 2. The gate names its lane and reports its wait

- [x] 2.1 Export `HEAVY_LOCK_LABEL="gate:<resolved sha>"` from `bin/h2puni-gate.sh` and gate that
      same resolved sha — test: `bin/h2puni-gate.test.sh` case 32 pins that the shipped gate
      labels its lane from the resolved commit, alongside the contract checks for the wait default.
- [x] 2.2 Assert the gate's wait line precedes its `running on` line and reports an integer —
      test: gate case 31 gates behind a three-second dummy holder; watched failing with no wait
      line at all before slice 1.5 landed.

## 3. Close the review's findings

- [x] 3.1 Refuse to leave a ticket behind: the holder leaves the queue on claim and a refused
      waiter takes its ticket with it — test: case 16 (16b success, 16d refusal, 16e while
      holding); negatives: removing the claim-time delete leaves the holder's own ticket queued
      for the whole run, and installing `true` in place of the trap's removal leaves a refused
      run's ticket in the queue.
- [x] 3.2 Expire a ticket whose owner has stopped waiting, because pids are recycled and a
      SIGKILLed waiter's ticket would otherwise look alive for ever: record `deadline` on the
      ticket and reclaim a minute past it — test: case 17 plants a ticket from this suite's own
      live pid with a passed deadline; negative for the guard that reads it: defaulting a missing
      deadline to 0 reclaims a ticket whose deadline could not be read at all (17d, 17e).
- [x] 3.3 Keep the caller's EXIT trap: `install_release_trap` chains the trap captured by
      `trap -p EXIT` — test: `bin/h2puni-gate.test.sh` case 33 refuses a gate-shaped fixture while
      queued and asserts its mktemp directory is gone; negative: with the chain replaced by a
      plain `trap … EXIT` the directory is leaked.
- [x] 3.4 Stop refusing over transients: publish the ticket by writing a dot-named draft and
      renaming it (case 19), and distinguish an absent holder or label from an unreadable one
      (case 18) — negatives: reading absent as unreadable refuses a lock that is merely being
      claimed (18a, 18c); removing the `-r` branches turns the refusal into `cat: … Permission
denied` and exit 1 (18e, 18f).
- [x] 3.5 Name the reason in the deadline refusal: the tickets ahead and their lanes, not a holder
      the free lock does not have — test: case 20; negative: the unconditional holder line that
      shipped reports `is held by pid ?`.

## 4. Survive a queue that is moving

- [x] 4.1 Treat state that disappears mid-read as gone rather than as unknown: `read_ticket_label`
      and `read_ticket_deadline` read first and classify after, returning 66 for a ticket that has
      left the queue, and both call sites skip it — test: case 21, a `sed` shim that deletes the
      ticket it is asked to read; negative: with the `-r` test in front, both the waiting run and
      the report exit 70 (`21a`, `21b`).
- [x] 4.2 The same shape for the holder file, which had the same window and was watched losing the
      race in the suite with nothing injected — test: case 24, a `cat` shim that deletes the
      holder file; negative: with the pre-fix order, a released lock is reported as corrupt
      (`24a … want exit 0, got 70`) and an empty holder file is refused 70 rather than retried
      (`24c`).
- [x] 4.3 Sweep drafts left by runs killed mid-write, by the pid in their name — test: case 23;
      negative: with the sweep absent the draft survives every run.
- [x] 4.4 Isolate the release trap's steps and keep the run's exit status — test: case 22, whose
      lock directory cannot be removed; negative: the unisolated list turns exit 42 into 1 and
      skips the caller's chained EXIT trap.
- [x] 4.5 Report a ticket ahead that cannot be named as `unknown` rather than `gone` — test: case
      20d; negative: the single `gone` describes a ticket that is still in front as one that has
      left.

## 5. Read the status files first, and bound the poll

- [x] 5.1 `report_heavy_lock_status` reads holder and label before deciding anything about them —
      test: case 25, the case-24 `cat` shim against `status`; negative: testing before reading
      kills the report outright (`25a … want exit 0, got 1`, `cat: …/holder: No such file`).
- [x] 5.2 Validate `HEAVY_LOCK_POLL_SECONDS` at the boundary — 1 to 30 whole seconds, read as
      decimal and written without a leading zero, because a ticket is reclaimed 60s past its
      deadline and that is only safe while the owner's last claim lands within one poll, and
      because a zero interval spins on the lock directory for the whole budget — test: case 26;
      negatives: with the check absent `abc` and `300` are accepted in silence (`26a`, `26c`), and
      with the bound written without `10#`, `031` passes as octal 25 and then sleeps 31 while `08`
      errors the comparison into a pass (`26e`, `26f`); `0` passed until this refused it (`26h`).
- [x] 5.3 Sync the artifacts and the docs to what shipped: `tasks.md` and `verify.md` cover every
      case, `CONTEXT.md`'s **Ticket** carries its deadline, the suite header's proof list reaches
      case 26, the delta spec gains scenarios for the draft sweep, the named refusal and the
      vanishing read, item 12 of the agent-loop audit points at this change, and the four
      pre-existing lock shapes the review found are queued in `docs/refactoring/tasks.md`.
- [x] 5.4 Report the two states a `status` racing a release can find: a lock whose directory has
      gone is `holder none`, and a holder file that is present but empty is `holder claiming` — the
      instant `claim_heavy_lock` already answers with 75 — test: cases 25c-25f; negatives: with the
      released-lock branch removed the report says `holder claiming` about a lock nobody holds, and
      without the empty-file half it says `holder pid  label held`.

## 6. A signalled run stops

- [x] 6.1 INT and TERM release and then exit 130/143, clearing the EXIT trap first so the release
      and the caller's inherited trap run exactly once; a holder's command is deliberately not cut
      short, because it is the work the lock exists to serialise — test: case 27; negatives: with
      the release-only handler that shipped, a TERM'd waiter survives, keeps polling without a
      ticket and claims the lock the holder released (`27a … want exit 143, got 0`, `27d`), and
      the caller's own EXIT trap runs twice (`27j`).

## 7. Verification

- [ ] 7.1 Run the full gate on h2puni at the change head and record commands, results and the R5
      proof table in `verify.md`. **Done except its last clause**: the gate is green on `5f9551b8`
      (`h2puni gate: running on 5f9551b83d4777d1dbbb476c3047ec1767a81a93`, exit 0) and `verify.md`
      records it along with the queue observed running in production. What remains is the rollout
      drain check — `bin/with-heavy-lock.sh status` empty before the first post-merge heavy run —
      which belongs to whoever is at the host at deploy.
