# The agent loop, audited — 2026-08-30

**2026-09-16.** What this audit calls lanes is Claire's first-version SDLC
mechanism, stated as three repository contracts in
[lanes are Claire's v1 mechanism](lanes-are-claire-v1.md). Read the rest as
history: the findings are what was watched on those dates, not a description of
how the loop runs today.

Written while landing the five outstanding items of
`openspec/DANY-REQUEST-AUDIT-2026-08-30.md` with a second Claude session and its
five agents working the same repository at the same time.

Two things are recorded here, and the second is the one worth keeping:

1. **The plan** — what Dany asked for, what is actually on `main`, who owns
   which branch, and what is left.
2. **What the loop got wrong** — thirteen findings: measurements that were
   green, or red, for reasons other than the ones claimed; one piece of shared
   machinery that does not do what its name says; and one gap that belongs to
   nobody, which is the last and the most general. Every one was found by
   checking rather than by reasoning.

---

## Part 1 — the plan

### The audit's own table was wrong in both directions

`DANY-REQUEST-AUDIT-2026-08-30.md` checked `main` by grepping for a shipped
symbol. That method under-reports, and it did:

| #   | Ask                                         | Audit said           | Actually                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Hover tooltip right of the project dropdown | **NO**               | **on `main`** — `ProjectOptionCard` in `project-page.tsx` portals a `HoverCard beside={anchor}` clear of the listbox's right edge, with owner, restricted, start and last-opened. Its change's only open task is "deploy to dev and Dany looks", a human item |
| 2   | Rename Phases → Steps                       | "15 open, unstarted" | 15 of 15 slices ticked; merges into `main` with **zero conflicts**; only its gate is outstanding                                                                                                                                                              |
| 7.1 | Gantt deps from all steps                   | 14 open              | branch complete, units green, gate outstanding                                                                                                                                                                                                                |
| 7.2 | Unestimated steps assume 2 days             | 9 open               | 7 of 9; the two open are gate items                                                                                                                                                                                                                           |
| 3   | One project-config modal                    | 11 open, unstarted   | correct — no code, no branch                                                                                                                                                                                                                                  |

**Outstanding is four, not five.** A `tasks.md` tick is not evidence, and
neither is its absence — which is the same error in the other direction.

### Ownership, settled between the two sessions

`.claude/worktrees/*` share **one `.git`**. A branch name resolves to exactly
one ref for every session, and every session on this machine commits under the
same git author, so `%an` distinguishes nothing. **The worktree assignment is
the only reliable signal of who owns work**, and it is not visible from the
other side.

| Branch                                          | Owner             |
| ----------------------------------------------- | ----------------- |
| `assumed-duration-schedules` (ask 7.2)          | this session      |
| `project-config-modal` (ask 3)                  | this session      |
| `work-item-types`, `external-refs`              | this session      |
| `dep-reach-whole-item` (ask 7.1)                | the other session |
| `steps-not-phases` (ask 2)                      | the other session |
| `tags-accumulate`, `plan-toolbar-controls-gate` | the other session |

**Standing rule, agreed after three violations: never commit inside
`.claude/worktrees/agent-*`.** Reading one is fine. If a branch there needs
`main` merged forward, ask its owner to do it between runs, when nothing is
measuring.

### What is left (as of the last edit; `openspec/HANDOFF-2026-08-30.md` is live)

1. `assumed-duration-schedules` — **merged to `main`**, ask 7.2 done.
2. `project-config-modal` — **written, on `feat/project-config-modal`**, jsdom
   suites green, eight negatives watched; waiting on the lock for fe-01's gate
   and the whole browser gate, then merge. Built against `Phases` by agreement
   with `steps-not-phases`' owner; that change's sweep renames the tab.
3. `steps-not-phases` and `dep-reach-whole-item` — the other session's, both
   merged forward onto `main` and gating.

`steps-schema-rename` is the physical `role`→`step` table rename. It is the
second half of ask 2 in the audit's framing, but **Dany's ask is user-visible
wording**, which `steps-not-phases` satisfies on its own. Recorded as a
deliberate deferral rather than an omission.

---

## Part 2 — thirteen things that meant something else

R5 says a check whose failure has never been observed is a claim, not a gate.
The loop produced a matching family: **a result whose _cause_ has never been
established is not evidence either**, whichever colour it is.

### 1. A gate that measured a checkout nobody was editing

The full browser gate ran on port shift 1500 while another agent's gate was
also on 1500. It reported **229 passed / 4 failed** and the failures had an
innocent-looking explanation, so it read as clean. It was not clean: two suites
shared one set of ports, and nothing in the number says so. Re-run serialised
under a dedicated browser lock before it was believed.

**A browser number is not evidence unless you know what else was running when
you took it.**

### 2. `git add -A` in a worktree whose owner had not been established

Commit `14a5bf5`'s message describes one JSDoc line. Its contents are **twelve
files and 388 insertions** of another agent's in-flight work. Not rewritten —
it sits under two merge commits, and a corrected record in `verify.md` naming
the hash and the true contents is worth more than a tidy history that hides
that it happened.

### 3. A `verify.md` asserting a run nobody made

It recorded `fe-01:test` at **1949 pass**. The real figure is **1899 pass, 0
fail, 60 files**. The agent that took the measurement caught its own document.
Had it not, the next merger would have read 1949 as evidence.

**This is R5's own failure wearing the costume of a passing document**, and it
is the most dangerous item on this page, because nothing about a verify table
looks like a claim.

### 4. "Fails on `main`" used as a reason not to look

Three browser checks fail on `main` on this host. Two are documented in
`apps/fe-01/playwright.config.ts` as environmental: a non-US host renders
`dd.mm.yyyy` segments, so `05202026` saves 2026-02-05 rather than 2026-05-20,
with `locale: 'en-US'` and `--lang=en-US` both tried and both failing to reach
Chrome's segment order.

The third, `deps-cell.spec.ts:432`, was on that list too — and **it was a real
bug the whole time.** Both sessions reproduced `Expected: 0 / Received: 42` on
`document.getAnimations().length` and neither could explain it, so it sat as a
third "environmental" red every agent was told to ignore.

It was not environmental. `chooseTheme` waited for the animation count to reach
zero, which that page never reaches: a **finished** `CSSTransition` is not
dropped for a subtree Chromium has stopped recalculating. Measured in
Playwright's own Chromium — 155 → 42 at ~425ms, then flat, every one `finished`
with `fill: backwards`, 36 on `BUTTON` and 6 on `INPUT`, one per animated
property. `dark-mode.spec.ts` and `priority-ramp.spec.ts` already filter on
`playState`; this file had never been brought in line. Fixed on `origin/main` at
**`26d6166`**, 10/10, negative watched at `Expected: 0 / Received: 42` — so the
two-not-three list is now true of the repo rather than only of our knowledge,
and an agent pulling that commit stops seeing the red without being told to
ignore anything.

**The known-failing list on this host is two, not three.** Being told to ignore
a red is how a real one gets ignored — and this one was, by both of us, for a
day.

### 5. A port-clearing recipe that was a loaded gun at five agents

`kill $(lsof -ti :$p)` is safe with one agent. With five it killed a
neighbour's be-01 **83 seconds into a run**, after which the log showed **134
failures at a uniform ~10.4s each, every one fictitious**. The agent reading it
correctly diagnosed a dead server rather than reporting any single failure as
real.

Two rules came out of it, both now on `main` beside the guard:

- **Check a PID is yours before killing it** — the process must live under your
  own worktree.
- **Two shifts must be more than 100 apart**, and clear of what the host itself
  listens on. `E2E_PORT_SHIFT=1700` puts fe-01 on **5900 — macOS Screen
  Sharing**, a root-owned listener invisible to a user `lsof`, so Playwright
  reports the port busy and a pre-flight check sees nothing.

**But the sequence matters more than the rules, and it is not flattering.** A
collision guard shipped; an agent immediately hit a case it did not cover; 1700
was assigned to fix that; 1700 was itself broken by a listener nobody had
checked for. Three fixes, each with the next hole in it.

**Each fix was written from the same place the bug came from — reasoning about
the port arithmetic rather than measuring the host.** The guard knows the three
defaults, which a config can know; it cannot know what else is running, and it
cannot know what the machine itself listens on. Both facts were available before
either fix was written.

## 7. Three more, found while landing the last two asks

**A test that passed "under either reach" was passing because the two arms
coincided on that fixture.** `a predecessor nobody estimated is reached at its own
finish under either reach` held while zero-length slices made the anchor's finish
and the last slice's finish the same day; with assumed durations they are day 5
and day 7, and it asserts per-arm numbers now. A check that is green under two
rules is not thereby insensitive to the rule — it may be that the fixture cannot
tell them apart. Same shape as the vacuous checks above, one layer up. (Found by
the other session; the "either" was this session's.)

**A correct habit and an incorrect instruction can coexist indefinitely.** The
handoff told readers to reconcile a Playwright run with `grep -E "Running [0-9]+
tests"`. Playwright colourises that line with escapes _between the words_, so the
grep matches nothing and "no count found" reads exactly like "not a partial run".
The author of the instruction had been stripping escapes with `sed` all day and
never noticed the instruction did not say so — **the person who writes a recipe
rarely runs it as written.** Fixed with the literal `sed` in the doc.

**A `Proof:` comment is a claim until the run.** `project-config-modal` slice
3.2 says "the control carries no `data-takes-the-focus`", and the comment on its
test said that attribute had been injected and watched failing. Run in isolation
by a subagent, it **passed with the fault in**: the sheet reads that mark only off
a control that closes the sheet, and a control that opens its own surface never
does. Replaced by the fault that is real (the `ModalTrigger` swapped for a plain
`Button`), watched failing in two suites. The other seven negatives for that
change were watched by subagents in detached worktrees before the comments were
believed, which is the discipline this item argues for: **never write "watched"
before the watching.**

## 10. A check whose measured quantity cannot move under its own fault

`project-config-modal`'s `tasks.md` asks that "the folded toolbar at 1280 is no
wider than before, with the pre-change figure pinned as a number". Measured on
`main` in Chromium, that reading **cannot fail**: the bar's content width at 1280
is `1248px`, which is the bar's own width, because the eighteen controls already
wrap to a second row. A full bar measures its own width whatever is on it — the
check passes with three buttons added _and_ with ten removed.

The other session named the family, and the name is better than the instance:
**a check whose measured quantity is invariant under the fault it names.**
`deps-cell`'s drain (item 4) is its sibling — the polled count could never reach
the asserted value — and neither is visible by reading the assertion. They are
visible only by asking _what the number is a measurement of_.

The replacement pins what the bar has to **lay out** — every control's width plus
the gaps, `1445.33px` over 18 controls at a 6px gap, across `2` rows — and
asserts **≥16 controls present first**. That precondition is not decoration: it is
what stops the new check acquiring the same property, since a bar that lost
controls could otherwise satisfy the budget by shrinking.

## 11. A merge diff attributes every line it carries, including the ones it imports

Two sessions believed they had independently fixed the same stale docking test,
and that whoever merged second faced a judgement call about which correction to
keep. `git diff` showed 97 changed lines in `plan-surface.spec.ts` on the second
branch, which was true and meant nothing:

```
$ git merge-base --is-ancestor 6fe8a26 58ded95   # already in its history
$ diff <(git show 58ded95:…/plan-surface.spec.ts) <(git show main:…/plan-surface.spec.ts)
421c421
<     // An unfolded step is what makes the frame scroll sideways at all
---
>     // An unfolded role is what makes the frame scroll sideways at all
```

One line, a comment, and the word was that branch's own rename sweep. The 97
lines were the _first_ session's correction arriving through a merge of
`origin/main`. All four of that session's branches merge `main` with **zero**
conflicts.

Same shape as `eb8968d` (item 5's neighbour): a real number supporting a wrong
story until somebody read the commit that produced it. The session that made
both calls named what they share, and together they are a rule rather than two
anecdotes: **both times a number was taken off a summary view and authorship or
intent inferred from it.** `git show --stat` on a _merge_ commit attributes every
line the merge carries, including the ones it imports; a measured pixel figure
says nothing about why the pixels moved.

**The summary tells you what changed; only the history tells you who changed it
and why.** `git merge-base --is-ancestor` and `git merge-tree` are the cheap
answers, and both run in under a second.

## 12. The "queue" is a lottery, and a long job can starve behind short ones

**Resolved 2026-09-16 by the `fifo-heavy-lock` change** (`openspec/changes/fifo-heavy-lock/`):
the loop takes a ticket and waiters are served in arrival order.

`HEAVY_LOCK_WAIT_SECONDS` reads as queueing, and `bin/with-heavy-lock.sh`'s own
docstring calls it "queue instead of refusing — that is what several agents
sharing one Mac want". It is not a queue. The loop is:

```sh
while true; do
  claim_heavy_lock "$lock_dir" && break     # bare mkdir
  ((SECONDS >= deadline)) && return 75
  sleep 5
done
```

Every waiter polls `mkdir` on the same 5-second cadence and **the winner is
whoever calls it first after a release**. There is no ticket, no arrival order,
no ageing. With three sessions and jobs ranging from 20 seconds to 40 minutes,
a waiter's odds do not improve with time spent waiting.

Measured on 2026-08-30: one browser run waited **50 minutes** while four other
jobs — several of them minutes old — took the lock and finished. It was first by
arrival in every one of those rounds and won none of them.

This is not a bug in the lock's _correctness_: it never lets two heavy runs
overlap, which is what it exists for, and the eighteen R5 entries it guards are
all about that. It is a gap between what the name promises and what the
mechanism provides. **"Queue" in the docstring should read "retry", or the loop
should take a ticket** — and until one of those, a session planning around
"my gate is next" is planning around something the code does not offer.

The operational consequence, for anyone reading this while three sessions are
live: **budget wall-clock by the number of competing sessions, not by your job's
own length**, and set `HEAVY_LOCK_WAIT_SECONDS` generously — a 20-second
measurement legitimately needs a two-hour budget on a contended host.

## 13. A check can be right in isolation and wrong about a composition

Three times on 2026-08-30 a check was correct about its own change and false
about that change met with another. None was an attention failure and none could
have been caught earlier by anyone being more careful.

| Check                                                                            | Right about                  | Wrong about                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `a predecessor nobody estimated is reached at its own finish under either reach` | both reaches, on its fixture | the fixture made the two arms **coincide**; with assumed durations they are day 5 and day 7                                                     |
| `assumed-duration-schedules`' "adds exactly one assumed duration to every leaf"  | the anchor rule              | under `whole-item` the assumption **compounds down a chain**: `010` +2, `020` +2, `030` +4                                                      |
| `gantt.spec.ts`'s `redraws the open chart as each schedule input changes`        | either change alone          | under both, the dependent starts day **12**, not 10 — it waits for a predecessor whose last slice is an unestimated `QA` now worth two workdays |

**The cause is structural, not human.** Each was written by someone who had the
whole of their own change in view and none of the other's. Every change here has
an owner and every branch has a gate — **the pair of changes has neither**, until
the moment they meet.

The consequence is the rule worth keeping:

> **The first full gate on a merged tree is not a formality. It is the only test
> that has ever seen the composition.**

All three were found exactly there, and could not have been found anywhere else:
not on either branch, not by 1939 jsdom tests, and not by any suite that runs
before the merge exists. It is also why a gate that ran on a pre-merge tree —
however green, however recent — is not evidence about what will land. That is
this document's other recurring fault (items 3 and 11) arriving from a third
direction: **a measurement of a tree that is not the tree.**

### Three artefacts that look like conclusions

The verify table, the review, and the instruction to five agents all failed the
same way in one afternoon, and the failure is identical in each:

- A `verify.md` row read **1949 pass**. Nobody ran it.
- A review said the override's docstring permitted a second lane. It was quoted
  from a branch read hours earlier; the file said the opposite.
- An instruction told five agents they had two lanes. The seam had been deleted.

**A docstring quoted from memory is the "1949 pass" failure one artefact along.**
Each of the three is a claim wearing the shape of a conclusion, and **none of
them carries a marker saying which it is** — that is what makes the family
dangerous rather than merely wrong. A test at least announces its colour. A
table, a review and an instruction all read as settled by construction.

The cheap defence is the same in all three cases and costs under a minute: open
the file, run the command, read the ref. It was skipped every time by someone
who had genuinely read the thing — earlier, elsewhere, or on another branch.

### The shape they share

Four of the six are **an assertion made outside the window the fault lives
in** — `AGENTS.md`'s own R5 family, at the level of the loop rather than the
test. The green was real; what it described was not what anyone thought.

The cost of checking, every time, was under a minute. The cost of not checking
was a destroyed branch narrowly avoided, a 7-minute gate invalidated, and a
false measurement one merge from being cited as proof.

---

## What actually worked

- **Two sessions each caught the other's false premise**, within a minute, by
  running the command instead of arguing. One of them would otherwise have
  ended in `git branch -D` against a live branch.
- **An agent reported a fictitious 134-failure log as a dead server**, not as
  134 findings.
- **An agent corrected its own `verify.md`** rather than shipping the number
  that flattered it.
- **A retraction, carried by the session that proposed it.** See below; it is
  the sixth item, and it is here rather than in Part 2 only because the thing
  that caught it was the repo's own test.

---

## 6. The two-lane lock — proposed, endorsed, and wrong

The other session split heavy work into two named lanes, browser gates taking
`/tmp/wbs-heavy-browser.lock` via a `$WBS_HEAVY_LOCK` override, and asked me to
check the reasoning. **I endorsed it as "squarely within" the override's
documented purpose. It was not, and I should have read the file rather than the
branch I had seen it on hours earlier.**

`$WBS_HEAVY_LOCK` no longer exists. `bin/heavy-lock-lib.sh` now says why, and it
describes the proposal exactly:

> **No environment override, and that absence is the point.** An earlier cut of
> this took `$WBS_HEAVY_LOCK` so a test could aim two runs at a private mutex —
> and `tool-dagger/src/heavy-lock.test.ts` caught it, because a caller able to
> choose its own lock path is a caller able to opt out of the lock: two heavy
> runs set it differently, take two different mutexes, and both proceed. That is
> the exact failure this file exists to prevent, reintroduced by its own test
> seam.

Nothing was damaged in the mechanism — setting the variable is a no-op, so every
run took the canonical lock and queued. **But the throughput the lanes claimed
was never real**, and a design reviewed by two sessions survived both because
neither opened the file.

**The consequences were not a no-op.** The instruction reached five agents, and
one of them ran two heavy commands at once on the strength of it — which is
where the ten contaminated failures below came from. **A design that is a no-op
in the mechanism can still change behaviour through what people do believing it
works.**

**Consequence for reading any red from the lock suites.**
`tool-devsync`, `tool-dagger` and `tool-bootstrap` assert _contention
behaviour_ — `refuses immediately with exit 75 while another heavy operation
owns the lock` cannot survive a second lock-holding process on the machine. One
agent saw ten failures across the three, with `configure.sh` cases timing out at
60s after **293s** of wall clock: starvation, not code.

**So that suite is order- and load-sensitive by design, and any run of it beside
another heavy job is uninterpretable — including the "quiet `main` baseline"
recorded in this session.** That baseline showed `tool-bootstrap` 53/7 and
`tool-devsync` 26/2, matching the branch under test, which is still evidence
that the branch did not cause them. It is not evidence that those figures are
what a serialised machine would print.
