#!/usr/bin/env bash
set -euo pipefail

# The host-wide mutex that keeps two heavy runs (the gate, a release build, an
# agent's `nx run-many -t test`) off the same machine at once.
#
# Mechanism is `mkdir`, not `flock`, on EVERY platform deliberately. `flock` is
# absent from macOS, so a `command -v flock` fallback would silently hand two
# concurrent runs two DIFFERENT mutexes on a host where one run found it and the
# other did not — mutual exclusion that cannot fail because it never engaged.
# `mkdir` is atomic on every POSIX filesystem and has no dependency to be
# missing, so one mechanism holds everywhere.
#
# See {@link resolveHeavyLockPath} for why the path is not $TMPDIR on macOS.

# The one canonical host-wide path for the heavy-work lock.
#
# **No environment override, and that absence is the point.** An earlier cut of
# this took `$WBS_HEAVY_LOCK` so a test could aim two runs at a private mutex —
# and `tool-dagger/src/heavy-lock.test.ts` caught it, because a caller able to
# choose its own lock path is a caller able to opt out of the lock: two heavy
# runs set it differently, take two different mutexes, and both proceed. That is
# the exact failure this file exists to prevent, reintroduced by its own test
# seam.
#
# Tests get their seam from {@link with_heavy_lock}'s first argument instead,
# which is a path they pass explicitly. Production reaches it through
# `bin/with-heavy-lock.sh`, which calls this and takes what it is given.
#
# h2puni's cache dir on Linux, and `/tmp` on macOS — NOT `$TMPDIR`, which macOS
# sets per-user-per-login-session (`/var/folders/…`), so two agents under
# different sessions would take two different locks and both proceed.
resolve_heavy_lock_path() {
  case "$(uname -s)" in
    Linux) printf '%s\n' /home/puni1/.cache/wbs-heavy-work.lock ;;
    Darwin) printf '%s\n' /tmp/wbs-heavy-work.lock ;;
    *)
      printf 'heavy lock: unsupported platform %s\n' "$(uname -s)" >&2
      return 1
      ;;
  esac
}

# True when $1 names a process this user can signal.
#
# `kill -0` reports EPERM as failure too, which would read a live lock holder
# owned by another user as stale. Every heavy run on these hosts is the same
# user, so EPERM here means the PID was recycled by a daemon and the holder we
# recorded is gone either way.
is_process_alive() {
  kill -0 "$1" 2>/dev/null
}

# Nanoseconds since the epoch, as the 19 digits a ticket name sorts by.
#
# The ANSWER is checked, not the exit status, because BSD `date` on macOS does
# not fail on `+%N` — it prints a literal `N`. A ticket named `1758…N-4321` sorts
# before every real ticket, so that host would quietly hold the head of the queue
# for ever. Homebrew coreutils and `python3` are what a Mac can have instead;
# with neither, this refuses rather than queueing in an order it cannot compute.
#
# Proof (observed 2026-09-16): against a PATH whose `date` prints BSD-style
# `1758012345N` and which has no `python3`, dropping the `^[0-9]{19}$` check
# alone still refuses — {@link read_ticket_pid} catches the name it produced,
# with the wrong diagnosis: `queue holds 1758012345N-1701207, which is not a
# <nanoseconds>-<pid> ticket`, exit 70 about the queue rather than the clock.
# Dropping BOTH was watched enqueueing `1758012345N-<pid>` and running anyway —
# `14b: it ran on a ticket it could not order`, exit 0 where the guard gives 70
# (bin/heavy-lock.test.sh, case 14).
read_epoch_nanoseconds() {
  local stamp
  if stamp=$(date +%s%N 2>/dev/null) && [[ $stamp =~ ^[0-9]{19}$ ]]; then
    printf '%s\n' "$stamp"
    return 0
  fi
  if stamp=$(python3 -c 'import time;print(time.time_ns())' 2>/dev/null) &&
    [[ $stamp =~ ^[0-9]{19}$ ]]; then
    printf '%s\n' "$stamp"
    return 0
  fi
  printf 'heavy lock: no nanosecond clock here (date +%%s%%N and python3 time.time_ns both unusable); refusing to queue in an order it cannot compute\n' >&2
  return 70
}

# The pid encoded in ticket name $1, or 70 when the name cannot be ordered.
#
# A queue entry that is not `<nanoseconds>-<pid>` is unknown state twice over:
# nothing can say whether it arrived before ours, and nothing says whose it is.
# The tempting reading — "no live pid in the name, so it is dead" — deletes a
# file this code did not write, on the strength of a name it could not parse.
#
# Proof (observed 2026-09-16): replacing this condition with `false` was watched
# taking a stray `note` in the queue directory as a ticket from dead pid `note` —
# `heavy lock: removing ticket note from dead pid note`, the file deleted, exit 0
# where the guard gives 70 (bin/heavy-lock.test.sh, case 12).
read_ticket_pid() {
  local ticket_name=$1
  if [[ ! $ticket_name =~ ^[0-9]{19}-[0-9]+$ ]]; then
    printf 'heavy lock: queue holds %q, which is not a <nanoseconds>-<pid> ticket; refusing to guess its place\n' "$ticket_name" >&2
    return 70
  fi
  printf '%s\n' "${ticket_name##*-}"
}

# The lane label recorded in ticket file $1, or 70 when it cannot be read.
#
# A ticket that exists but cannot be read, or that records no label, is trusted
# state this code wrote and can no longer account for. `status` exists to tell a
# human which lane is holding the host up, and a waiter reported with a blank
# label is the one answer worse than no answer.
#
# Proof (observed 2026-09-16): replacing both refusals with an `unlabeled`
# default was watched reporting `heavy lock: waiter pid 999999 label unlabeled
# age 789539464s` for a ticket whose `label` line had been deleted, and the same
# for a mode-000 ticket — exit 0 twice where the guard gives 70
# (bin/heavy-lock.test.sh, cases 13b and 13c).
read_ticket_label() {
  local ticket=$1
  # Line 2 and only line 2. A ticket also records the command it queued for, and
  # a command containing a line of its own that begins `label ` would otherwise
  # contribute a second label and put a newline through the middle of a `status`
  # line.
  #
  # **The read comes first and its failure is classified afterwards**, because a
  # `-r` test cannot tell a ticket that is GONE from one that is unreadable — it
  # is false for both — and the two are opposites here. A ticket claimed or
  # reclaimed by someone else while this scan runs is what a moving queue looks
  # like; refusing 70 over it made a run fail for having read a queue that was
  # working. Exit 66 says gone, and every caller skips that ticket.
  #
  # Proof (observed 2026-09-16): with the `-r` test in front, a `sed` shim that
  # deletes the ticket it is asked to read — the race made certain rather than
  # rare — was watched failing both the waiting run and the report:
  # `21a … want exit 0, got 70` and `21b … want exit 0, got 70`
  # (bin/heavy-lock.test.sh, case 21).
  local label
  if ! label=$(sed -n '2s/^label //p' "$ticket" 2>/dev/null); then
    [[ -e $ticket ]] || return 66
    printf 'heavy lock: ticket %s is unreadable; refusing to report a waiter it cannot name\n' "$ticket" >&2
    return 70
  fi
  if [[ -z $label ]]; then
    printf 'heavy lock: ticket %s records no lane label; refusing to report a waiter it cannot name\n' "$ticket" >&2
    return 70
  fi
  printf '%s\n' "$label"
}

# The epoch second at which ticket $1's owner stops waiting, or 70 when the
# ticket does not record one.
#
# **`kill -0` alone cannot decide that a ticket is live.** Pids are recycled: a
# waiter killed with SIGKILL runs no trap, and the pid its ticket names may be
# handed to something unrelated minutes later — after which the ticket looks
# alive for ever and every lane on the host queues behind a ghost. A ticket
# therefore carries the instant its own owner would have given up, and
# {@link remove_dead_tickets} reclaims it a minute past that whatever its pid
# says.
#
# Line 4, for the reason {@link read_ticket_label} takes line 2: the command a
# ticket records is arbitrary text and must not be able to contribute a second
# deadline.
#
# Proof (observed 2026-09-16): replacing the epoch check with a `0` default —
# the shape a reader reaches for when a line is missing — was watched reclaiming
# a ticket from this suite's OWN live pid whose `deadline` line had been deleted:
# `17d … want exit 70, got 0` and `17e: it deleted a ticket whose deadline it
# could not read`, the run claiming the lock ahead of a waiter that was still
# waiting (bin/heavy-lock.test.sh, cases 17d-17e).
read_ticket_deadline() {
  local ticket=$1
  # Read first, classify after, and 66 for a ticket that has gone: see
  # {@link read_ticket_label}. This reader is the one every waiting run calls on
  # every ticket on every poll, so it meets a vanishing ticket most often — and
  # refusing 70 there killed the run doing the scanning rather than the queue it
  # was scanning.
  local deadline
  if ! deadline=$(sed -n '4s/^deadline //p' "$ticket" 2>/dev/null); then
    [[ -e $ticket ]] || return 66
    printf 'heavy lock: ticket %s is unreadable; refusing to guess when its owner stops waiting\n' "$ticket" >&2
    return 70
  fi
  if [[ ! $deadline =~ ^[0-9]+$ ]]; then
    printf 'heavy lock: ticket %s records %q as its deadline, not an epoch second; refusing to guess\n' "$ticket" "$deadline" >&2
    return 70
  fi
  printf '%s\n' "$deadline"
}

# The tickets ahead of $2 in queue $1, as `label (pid N)` oldest first.
#
# **A message, not a decision**, and that is why it is the one reader in this
# file that does not refuse over what it cannot read. The refusal it decorates
# has already been decided; a ticket that leaves the queue while this lists it is
# reported as `gone` rather than turned into an exit 70 that would replace a
# correct 75.
describe_tickets_ahead() {
  local queue_dir=$1 ticket_name=$2
  local described='' ticket ticket_name_ahead ticket_label
  for ticket in "$queue_dir"/*; do
    [[ -e $ticket ]] || continue
    ticket_name_ahead=${ticket##*/}
    [[ $ticket_name_ahead < $ticket_name ]] || continue
    # `gone` and `unknown` are different facts about a ticket ahead, and the
    # reader of this line is deciding whether to wait for it: one says it has
    # left the queue, the other that it is still in front and cannot be named.
    #
    # Proof (observed 2026-09-16): the single `gone` this replaced was watched
    # describing a ticket that was present, live and simply had no label line —
    # `gave up after 0s behind 1 tickets: gone (pid 2404329)`, which reads as a
    # queue that has emptied rather than one this run is still behind
    # (bin/heavy-lock.test.sh, case 20d).
    ticket_label=$(sed -n '2s/^label //p' "$ticket" 2>/dev/null) || ticket_label=''
    if [[ -z $ticket_label ]]; then
      if [[ -e $ticket ]]; then
        ticket_label=unknown
      else
        ticket_label=gone
      fi
    fi
    if [[ -n $described ]]; then
      described="$described, "
    fi
    described="$described$ticket_label (pid ${ticket_name_ahead##*-})"
  done
  printf '%s\n' "$described"
}

# Create the queue directory $1 if it is absent, or return 70 when it is unusable.
#
# **An unusable queue is not an empty one, and that is the whole guard.** The
# ticket glob over a directory this process cannot read expands to nothing, so
# without this every waiter reads a queue with nobody in it and takes the lock
# the moment `mkdir` succeeds: mutual exclusion still works, and the arrival
# order this file now promises silently does not.
#
# Proof (observed 2026-09-16): replacing both conditions with `false` was
# watched, against a mode-300 queue directory holding an older ticket from a LIVE
# pid, letting the newer run claim the lock ahead of it — it announced `heavy
# lock: waited 0s behind 0 tickets`, wrote its `RAN AHEAD OF THE QUEUE` marker
# and exited 0 where the guard gives 70. On a mode-500 queue the same fault turns
# the refusal into the ticket redirect's own bare `Permission denied` and exit 1
# (bin/heavy-lock.test.sh, cases 10a-10d).
prepare_ticket_queue() {
  local queue_dir=$1
  # Proof (observed 2026-09-16): removing this refusal never lets a run through —
  # the check below catches what it leaves — but it makes the answer wrong. With
  # a plain FILE at the queue path the surviving refusal said `queue directory …
  # is not readable and writable` about something that is not a directory at all,
  # and on a lock whose queue simply did not exist yet it refused every run the
  # same way: 10 of the suite's checks failed, none of them naming what was
  # actually wrong (bin/heavy-lock.test.sh, case 15b).
  if [[ ! -d $queue_dir ]] && ! mkdir -p "$queue_dir" 2>/dev/null; then
    printf 'heavy lock: cannot create the queue directory %s; refusing to claim out of order\n' "$queue_dir" >&2
    return 70
  fi
  if [[ ! -r $queue_dir || ! -w $queue_dir || ! -x $queue_dir ]]; then
    printf 'heavy lock: queue directory %s is not readable and writable; refusing to claim out of order\n' "$queue_dir" >&2
    return 70
  fi
}

# Remove every ticket in $1 whose pid is gone, naming each on stderr.
#
# Whoever sees a dead ticket removes it. A waiter killed with SIGKILL runs no
# trap, and one ticket nobody will ever claim against is a queue that never moves
# again — the starvation this change exists to end, in a worse form.
#
# Proof (observed 2026-09-16): replacing the reclaim with `:` was watched leaving
# a ticket from an exited pid at the head of the queue and refusing the next run
# with `heavy lock: … is held by pid ?`, exit 75 against a lock nobody held
# (bin/heavy-lock.test.sh, case 9).
remove_dead_tickets() {
  local queue_dir=$1
  local now ticket ticket_name ticket_pid ticket_deadline read_status
  now=$(date +%s)
  for ticket in "$queue_dir"/*; do
    # A glob that matches nothing expands to itself; an already-claimed ticket
    # disappears between the glob and this line, which is ordinary.
    [[ -e $ticket ]] || continue
    ticket_name=${ticket##*/}
    ticket_pid=$(read_ticket_pid "$ticket_name") || return $?
    if ! is_process_alive "$ticket_pid"; then
      printf 'heavy lock: removing ticket %s from dead pid %s\n' "$ticket_name" "$ticket_pid" >&2
      rm -f "$ticket"
      continue
    fi
    read_status=0
    ticket_deadline=$(read_ticket_deadline "$ticket") || read_status=$?
    # 66: someone claimed or reclaimed this ticket while the scan was reading it.
    # The queue moved, which is the queue working.
    if [[ $read_status -eq 66 ]]; then
      continue
    fi
    if [[ $read_status -ne 0 ]]; then
      return "$read_status"
    fi
    # A minute past its owner's own deadline. The grace is not politeness: the
    # owner may be inside the `sleep` of its final poll, and reclaiming a ticket
    # from a process that is about to claim with it is how two runs end up
    # believing they are next. 60s is twelve default poll intervals, and
    # {@link with_heavy_lock} refuses a `HEAVY_LOCK_POLL_SECONDS` above 30 so
    # that this stays at least two polls wide.
    #
    # Proof (observed 2026-09-16): with this branch removed, a ticket from a LIVE
    # pid whose deadline had passed two minutes earlier kept the next run out —
    # `17a … want exit 0, got 75`, refused by `is held by pid ?` about a lock
    # nobody held (bin/heavy-lock.test.sh, case 17).
    if ((now > ticket_deadline + 60)); then
      printf 'heavy lock: removing ticket %s from pid %s, whose wait budget expired %ss ago\n' \
        "$ticket_name" "$ticket_pid" "$((now - ticket_deadline))" >&2
      rm -f "$ticket"
    fi
  done

  # Drafts from runs killed mid-write. A SIGKILLed run runs no trap, and no
  # ticket glob matches a dotfile, so without this nothing would ever look at one
  # again: one file per killed run, for ever, on a host nobody cleans by hand.
  # The pid in the name is all this needs — a draft whose owner is alive is a
  # ticket being written right now, and removing it would delete a live run's
  # place in the queue before it took it.
  #
  # Proof (observed 2026-09-16): with this loop absent, a `.draft-` file from an
  # exited pid survived every run — `23b: the draft from a dead pid was left
  # behind for ever` (bin/heavy-lock.test.sh, case 23).
  for ticket in "$queue_dir"/.draft-*; do
    [[ -e $ticket ]] || continue
    ticket_name=${ticket##*/}
    ticket_pid=$(read_ticket_pid "${ticket_name#.draft-}") || return $?
    if ! is_process_alive "$ticket_pid"; then
      printf 'heavy lock: removing draft ticket %s from dead pid %s\n' "$ticket_name" "$ticket_pid" >&2
      rm -f "$ticket"
    fi
  done
}

# How many tickets in $1 arrived before ticket name $2.
#
# String comparison IS the numeric one here: every name starts with exactly 19
# digits, and equal-width digit runs collate the same way in every locale. A
# same-nanosecond tie falls through to the pid, which is arbitrary but total.
count_tickets_ahead() {
  local queue_dir=$1 ticket_name=$2
  local ahead=0 ticket
  for ticket in "$queue_dir"/*; do
    [[ -e $ticket ]] || continue
    if [[ ${ticket##*/} < $ticket_name ]]; then
      ahead=$((ahead + 1))
    fi
  done
  printf '%s\n' "$ahead"
}

# Record who holds $1: the lane label first, then the pid.
#
# That order is load-bearing. A reader takes the pid file as proof that there IS
# a holder and the label as which lane it is, so writing the pid first opens a
# window where a holder exists whose label does not — and there is nothing to
# guess in that window, only something to refuse over.
record_lock_holder() {
  local lock_dir=$1
  printf '%s\n' "${HEAVY_LOCK_LABEL:-unlabeled}" >"$lock_dir/label"
  printf '%s\n' "$$" >"$lock_dir/holder"
}

# Print who holds the lock at $1 and who is queued for it, oldest first.
#
# On stdout, because this is the answer to a question a human asked rather than a
# diagnostic emitted beside other work; the refusals below go to stderr like
# every other refusal in this file.
#
# Reached in production as `bin/with-heavy-lock.sh status`, which supplies
# {@link resolve_heavy_lock_path}'s answer. The path is an argument for the
# reason the top of this file gives at length.
report_heavy_lock_status() {
  local lock_path=${1:?lock path is required}
  local lock_dir="$lock_path.d"
  local queue_dir="$lock_path.queue"

  if [[ ! -d $lock_dir ]]; then
    printf 'heavy lock: holder none\n'
  elif [[ ! -r $lock_dir || ! -x $lock_dir ]]; then
    # R5: a lock directory that exists but cannot be read is an unknown state,
    # and "no holder" is the one report that would send a human to clear a lock
    # that is legitimately held.
    #
    # Proof (observed 2026-09-16): replacing this condition with `false` was
    # watched reporting `heavy lock: holder pid  label ` for a mode-000 lock
    # directory, behind two `cat: … Permission denied` lines — a held lock
    # reported as nobody's, exit 0 where the guard gives 70
    # (bin/heavy-lock.test.sh, case 13a).
    printf 'heavy lock: %s is unreadable; refusing to report a holder it cannot name\n' "$lock_dir" >&2
    return 70
  else
    # **Absent is not unreadable**, and reading them as the same thing made this
    # report refuse over two ordinary states. `claim_heavy_lock` makes exactly
    # this distinction and this matches it on the transient states: the winner
    # between its `mkdir` and its holder write has no holder file YET, and a lock
    # taken before this file grew a queue has no label file at all. It does not
    # match on the corrupt one — a holder file whose contents are not a pid stops
    # `claim_heavy_lock` with exit 70, while this reports it verbatim, because a
    # human reading a report is better served by the bytes than by a refusal. Neither is unknown state; both
    # were being reported as `is unreadable`, exit 70, to a caller whose only
    # crime was running `status` at the wrong microsecond.
    # **Both files are read BEFORE anything is decided about them**, the way
    # {@link claim_heavy_lock} and {@link read_ticket_label} read theirs. A
    # holder that releases between a test and a `cat` takes both files with it,
    # and testing first made the report die on the read — `cat: …/holder: No such
    # file or directory`, exit 1 under `set -e`, from the one command whose whole
    # job is to be safe to run at any moment.
    #
    # Absent is then still not unreadable, which is the other half: an absent
    # holder is a claim in progress (or a release that just happened), an absent
    # label is a holder that predates the queue, and either file present but
    # unreadable is unknown state.
    #
    # Proof (observed 2026-09-16), three faults:
    #   - reading absent as unreadable, which the first cut did, was watched
    #     refusing a lock whose holder had not been written yet and one with no
    #     label file — `18a … want exit 0, got 70`, `18c … want exit 0, got 70`;
    #   - replacing the two unreadable branches with `false` was watched turning
    #     the refusal into `cat: …/holder: Permission denied` and exit 1 with no
    #     report at all — `18e`, `18f … want exit 70, got 1`;
    #   - testing before reading was watched, against a `cat` shim that removes
    #     the file it is asked to read, killing the report outright — `25a … want
    #     exit 0, got 1` (bin/heavy-lock.test.sh, cases 18a-18f and 25).
    local holder_pid='' holder_label='' holder_status=0 label_status=0
    holder_pid=$(cat "$lock_dir/holder" 2>/dev/null) || holder_status=$?
    holder_label=$(cat "$lock_dir/label" 2>/dev/null) || label_status=$?
    if [[ $holder_status -ne 0 && -e $lock_dir/holder ]]; then
      printf 'heavy lock: %s is unreadable; refusing to report a holder it cannot name\n' "$lock_dir/holder" >&2
      return 70
    fi
    if [[ $label_status -ne 0 && -e $lock_dir/label ]]; then
      printf 'heavy lock: %s is unreadable; refusing to report a holder it cannot name\n' "$lock_dir/label" >&2
      return 70
    fi
    if [[ $holder_status -ne 0 || $label_status -ne 0 ]] && [[ ! -d $lock_dir ]]; then
      # The holder released while this was reading it — the whole lock directory
      # is gone, not just the file. There is no holder now, and saying so is the
      # whole truth available.
      #
      # Proof (observed 2026-09-16): with this branch removed, a `cat` shim that
      # removes the lock directory it is asked to read from left the report
      # saying `heavy lock: holder claiming` about a lock nobody holds and nobody
      # is claiming — `25d: a lock whose directory has gone is reported as free,
      # not as being claimed` (bin/heavy-lock.test.sh, case 25c-25d).
      printf 'heavy lock: holder none\n'
    elif [[ $holder_status -ne 0 || -z $holder_pid ]]; then
      # Either the file is not there yet or it is there and still empty. Both are
      # the same instant, and it is the one {@link claim_heavy_lock} answers with
      # 75 rather than calling the lock corrupt — this now matches it on both
      # halves rather than only on the missing file.
      #
      # Proof (observed 2026-09-16): without the `-z` half, a present but empty
      # holder file was reported as `heavy lock: holder pid  label held` — a
      # holder with no pid, from the report, at an instant the claim path already
      # models (bin/heavy-lock.test.sh, case 25f).
      printf 'heavy lock: holder claiming\n'
    else
      if [[ $label_status -ne 0 ]]; then
        holder_label='unlabeled (pre-queue holder)'
      fi
      printf 'heavy lock: holder pid %s label %s\n' "$holder_pid" "$holder_label"
    fi
  fi

  [[ -d $queue_dir ]] || return 0
  # Proof (observed 2026-09-16): replacing this condition with `false` was
  # watched reporting a holder and NO waiters for a mode-000 queue directory
  # holding two tickets — exit 0, an empty queue it could not read
  # (bin/heavy-lock.test.sh, case 13d).
  if [[ ! -r $queue_dir || ! -x $queue_dir ]]; then
    printf 'heavy lock: queue directory %s is unreadable; refusing to report a queue it cannot read\n' "$queue_dir" >&2
    return 70
  fi

  local now ticket ticket_name ticket_pid ticket_label ticket_deadline ticket_budget read_status
  now=$(date +%s)
  for ticket in "$queue_dir"/*; do
    [[ -e $ticket ]] || continue
    ticket_name=${ticket##*/}
    ticket_pid=$(read_ticket_pid "$ticket_name") || return $?
    # 66 from either reader: the waiter took the lock, or its ticket was
    # reclaimed, between the listing and the read. It is not in the queue any
    # more, so it does not belong in a report of the queue — and a report that
    # exits 70 because the thing it was reporting on went away is a report nobody
    # can leave running.
    read_status=0
    ticket_label=$(read_ticket_label "$ticket") || read_status=$?
    if [[ $read_status -eq 66 ]]; then
      continue
    fi
    if [[ $read_status -ne 0 ]]; then
      return "$read_status"
    fi
    ticket_deadline=$(read_ticket_deadline "$ticket") || read_status=$?
    if [[ $read_status -eq 66 ]]; then
      continue
    fi
    if [[ $read_status -ne 0 ]]; then
      return "$read_status"
    fi
    # The budget is what says whether a waiter is still waiting or is a ticket
    # {@link remove_dead_tickets} is about to reclaim, which is the difference
    # between a queue that is moving and one that is stuck.
    if ((now < ticket_deadline)); then
      ticket_budget="$((ticket_deadline - now))s left"
    else
      ticket_budget=expired
    fi
    # `10#` because a stamp is read as a literal: a leading zero would otherwise
    # make bash treat it as octal and reject the digits 8 and 9.
    printf 'heavy lock: waiter pid %s label %s age %ss budget %s\n' \
      "$ticket_pid" "$ticket_label" "$((now - 10#${ticket_name%%-*} / 1000000000))" "$ticket_budget"
  done
}

# Take the lock at $lock_dir, or return 75 if someone else holds it.
#
# Reclaims a lock whose recorded holder is dead — a run killed with SIGKILL
# leaves the directory behind, and refusing every subsequent run until a human
# removes it by hand converts one crash into a wedged host.
claim_heavy_lock() {
  local lock_dir=$1
  local holder_file="$lock_dir/holder"

  if mkdir "$lock_dir" 2>/dev/null; then
    record_lock_holder "$lock_dir"
    return 0
  fi

  # R5: the lock exists but is unreadable — that is an unknown state, not a free
  # lock and not a held one. Throw rather than guess in either direction.
  #
  # **Read first, classify after**, the same way {@link read_ticket_label} does
  # and for the same reason: `-r` cannot tell a holder file that is GONE from one
  # that is unreadable, and testing it before the read leaves a window in which
  # the holder releases the lock — `rm -rf` takes the file with it — between the
  # test and the `cat`. The read then comes back empty and the pid check below
  # calls a released lock corrupt.
  #
  # Proof (observed 2026-09-16): with the `-r` test in front, a queueing run was
  # watched losing that race in the ordinary suite, with no fault injected at
  # all — `cat: …bash.d/holder: No such file or directory`, then
  # `holder holds '', not a pid; refusing to guess` and
  # `3a: a queueing run gets its turn: want exit 0, got 70`. Case 24 makes the
  # same window certain with a `cat` shim that removes the holder file before
  # reading it.
  local holder
  if ! holder=$(cat "$holder_file" 2>/dev/null); then
    if [[ -e $holder_file ]]; then
      printf 'heavy lock: %s exists but is unreadable; refusing to guess\n' "$holder_file" >&2
      return 70
    fi
    # Gone, or never written: either the winner is between its `mkdir` and its
    # write, or the holder released while this was reading. Both mean nobody is
    # recorded here now, and both are answered by trying again.
    return 75
  fi
  if [[ -z $holder ]]; then
    # Created but not yet written — the same instant as the branch above, seen
    # from the other side of `record_lock_holder`'s redirect.
    return 75
  fi
  # Proof: replacing this condition with `false` was watched reclaiming a lock
  # whose holder file read `not-a-pid` — "reclaiming … from dead pid not-a-pid",
  # then `RAN ON CORRUPT LOCK`, exit 0 where the guard gives 70
  # (bin/heavy-lock.test.sh, case 6).
  if [[ ! $holder =~ ^[0-9]+$ ]]; then
    printf 'heavy lock: %s holds %q, not a pid; refusing to guess\n' "$holder_file" "$holder" >&2
    return 70
  fi

  # Proof: replacing this function's body with `false` was watched letting a
  # second run start while the first still held the lock — `RAN CONCURRENTLY`,
  # exit 0 where the guard gives 75 (bin/heavy-lock.test.sh, case 2).
  if is_process_alive "$holder"; then
    return 75
  fi

  printf 'heavy lock: reclaiming %s from dead pid %s\n' "$lock_dir" "$holder" >&2
  rm -rf "$lock_dir"
  if mkdir "$lock_dir" 2>/dev/null; then
    record_lock_holder "$lock_dir"
    return 0
  fi
  # Another run reclaimed it first. It holds the lock; we do not.
  return 75
}

# Release what a run took, then run the caller's own EXIT trap `$4`, reporting
# every failure and letting none of them stop the rest.
#
# **Isolation is the whole point, and it is what `set -e` takes away.** The trap
# used to be one list — `rm -rf <lock>; rm -f <tickets>; eval <caller>` — so a
# failing `rm` aborted the trap where it stood: the caller's cleanup never ran
# AND the shell exited 1 instead of with the status the run had produced. Watched
# turning a real 75 into a 1. A trap is the last chance to clean up; a step of it
# that fails is a fact to report, not a reason to skip the other steps.
#
# This is the one place in this file that reports and continues instead of
# refusing, and the alternatives are worse rather than merely inconvenient: there
# is no caller left to hand an error to, and exiting non-zero here would destroy
# the run's own verdict. A lock directory that could not be removed is recovered
# by the next run through {@link claim_heavy_lock}'s dead-pid reclaim, and a
# ticket that could not be removed expires on its own budget, so both failures
# have an owner. Returns 0 so that bash exits with the status it was already
# exiting with (measured: a trap that returns 0 keeps the 75; one that fails
# under `set -e` replaces it with 1).
#
# The release runs BEFORE the caller's trap, not after: a caller trap that calls
# `exit` would otherwise skip the lock release entirely, and the lock is the part
# of this that other processes on the host are waiting for.
#
# Proof (observed 2026-09-16): restoring the unisolated list
# (`rm -rf <lock>; rm -f <tickets>; eval <caller>`) was watched, against a run
# whose lock directory could not be removed because its parent had lost write
# permission, turning the run's own exit 42 into 1, skipping the caller's EXIT
# trap, and saying nothing at all — `22a … want exit 42, got 1`,
# `22b: a release that could not finish skipped the caller's EXIT trap`,
# `22c: the release did not say what it could not remove`
# (bin/heavy-lock.test.sh, case 22).
release_heavy_lock() {
  local lock_dir=$1 ticket_path=$2 ticket_draft=$3 caller_exit_command=${4:-}
  if [[ -n $lock_dir ]] && ! rm -rf "$lock_dir"; then
    printf 'heavy lock: could not remove %s; the next run reclaims it from this pid\n' "$lock_dir" >&2
  fi
  if ! rm -f "$ticket_path" "$ticket_draft"; then
    printf 'heavy lock: could not remove ticket %s; it expires on its own budget\n' "$ticket_path" >&2
  fi
  if [[ -n $caller_exit_command ]]; then
    eval "$caller_exit_command" ||
      printf 'heavy lock: the exit trap this run inherited failed (status %s)\n' "$?" >&2
  fi
  return 0
}

# Trap the release of `$1` (empty while still queueing), ticket `$2` and draft
# `$3`, chaining on exit the caller's own EXIT trap `$4` as `trap -p EXIT`
# printed it.
#
# **The caller's EXIT trap is not ours to throw away.** `bin/h2puni-gate.sh`
# installs `trap 'rm -rf -- "$trusted_launcher_dir"' EXIT` before it ever reaches
# this file, and a plain `trap … EXIT` here replaces it. Before the queue existed
# that was bounded: the replacement happened only after the lock was claimed, so
# a gate refused at its budget still ran its own cleanup. A queueing run sets its
# trap BEFORE it waits, so without this chaining every gate that exits 75 at its
# 30-minute budget — or is interrupted while queued — leaves an mktemp directory
# behind on a host several lanes share, for ever.
#
# `$4` arrives exactly as `trap -p EXIT` printed it: `trap -- 'CMD' EXIT`, with
# CMD quoted by bash itself. The wrapper is stripped back to that quoted CMD and
# passed through as one word, so this never re-parses a quoting bash already got
# right. `trap -p` exists in bash 3.2.
#
# **INT and TERM release and then EXIT**, and the exit is the whole point.
#
# A trap handler that only cleans up does not stop a run: bash defers a trapped
# signal until the foreground child returns, runs the handler, and then CONTINUES
# the script. Watched on h2puni on 2026-09-16, pid 4049358: a waiter sent
# `kill -TERM` ran its release, deleted its own ticket, and went straight back
# into the wait loop as a waiter with no ticket — free to claim ahead of everyone
# who still had one. The cleanup mechanism broke the ordering it exists to
# protect, and `kill` stopped nothing. `bin/heavy-lock.test.sh` case 27a-27d is
# that observation, made deterministic.
#
# The conventional statuses, 128 + the signal number, because a caller reading an
# exit status has to be able to tell a signalled run from a refused one (75) or a
# broken one (70).
#
# The EXIT trap is cleared first. The handler runs the release INCLUDING the
# caller's chained command and then exits, so leaving EXIT armed would run both a
# second time — `rm` twice is harmless, but a caller's own cleanup is not ours to
# run twice.
#
# A HOLDER's command is not cut short, and that is a decision rather than an
# accident of bash's deferral: the command is the work the lock exists to
# serialise, and killing it from in here would abandon a checkout or a build in a
# state nobody chose. A caller that wants the command dead signals the process
# group. Case 27e-27g pins that the release and the exit still follow it.
#
# Proof (observed 2026-09-16): with the handler that shipped — release, no exit —
# a TERM'd waiter was watched surviving and taking the lock the holder released:
# `27a … want exit 143, got 0`, `27b: it took 5s to leave, which is not one
# poll`, and `27d: the signalled waiter claimed the lock after it was told to
# stop`. Also `27e`/`27h`/`27i … got 0` for a holder, an INT and a caller script.
# The same fault leaves the EXIT trap armed behind the handler, and the caller's
# own cleanup was watched running twice — `27j: the caller's own EXIT trap ran 2
# times`, which is what `trap - EXIT` above prevents
# (bin/heavy-lock.test.sh, case 27).
#
# Proof (observed 2026-09-16): replacing the chain with the plain
# `trap "rm -rf …" EXIT INT TERM` that shipped was watched leaving the gate
# fixture's mktemp directory behind after a gate refused 75 while queued —
# `FAIL: a gate refused while queued leaked its trusted-launcher directory`
# (bin/h2puni-gate.test.sh, case 33).
install_release_trap() {
  local lock_dir=$1 ticket_path=$2 ticket_draft=$3 caller_exit_trap=$4
  local release
  release="release_heavy_lock $(printf '%q' "$lock_dir") $(printf '%q' "$ticket_path")"
  release="$release $(printf '%q' "$ticket_draft")"
  if [[ -n $caller_exit_trap ]]; then
    local caller_exit_command=${caller_exit_trap#trap -- }
    caller_exit_command=${caller_exit_command% EXIT}
    release="$release $caller_exit_command"
  fi
  # shellcheck disable=SC2064 # Expanded now, deliberately: the paths are
  # function-locals that are out of scope by the time the trap runs, and under
  # `set -u` a deferred expansion aborts the trap and leaks what it was to
  # remove. `printf %q` rather than `${var@Q}`, which is a syntax error on the
  # bash 3.2 macOS ships.
  trap "$release" EXIT
  # shellcheck disable=SC2064 # Expanded now, deliberately: see above.
  trap "trap - EXIT; $release; exit 130" INT
  # shellcheck disable=SC2064 # Expanded now, deliberately: see above.
  trap "trap - EXIT; $release; exit 143" TERM
}

# Run `command [arg ...]` while holding the host-wide heavy-work lock.
#
# Refuses immediately with exit 75 when another run holds it, preserving the
# contract `bin/h2puni-gate.sh` and `bin/publish-release.sh` were written
# against. Set `$HEAVY_LOCK_WAIT_SECONDS` to queue instead of refusing — that is
# what several agents sharing one Mac want, where refusing just moves the
# thrashing into a retry loop.
#
# **Waiting is a QUEUE, not a race.** Every run leaves a ticket in
# `$lock_path.queue` named `<nanoseconds>-<pid>` before it tries to claim, and
# claims only as the oldest live ticket. The `mkdir` lottery this replaced went
# to whichever waiter's poll happened to land first, which is how a browser gate
# on h2puni waited 50 minutes while four jobs that arrived after it went ahead —
# the wait a waiter has already served bought it nothing, so the more lanes a
# host has, the likelier one starves.
#
# Every claim reports `heavy lock: waited <n>s behind <k> tickets` on stderr,
# including `waited 0s behind 0 tickets`: only this function knows either number,
# and a line that appears exactly when a run was delayed is a line nobody can
# grep for to find the runs that were not.
#
# **The exit codes a caller can see**, because scripts branch on them:
#   - the command's own status when it ran,
#   - `75` another run holds the lock, or a live ticket is ahead of this one,
#   - `70` state this cannot make sense of — an unwritable lock parent, an
#     unusable queue, a holder or ticket that is present and unreadable, no
#     nanosecond clock,
#   - `64` usage: no `--`, or a `HEAVY_LOCK_POLL_SECONDS` outside 1-30,
#   - `130` and `143` this run was sent INT or TERM; the lock and ticket are
#     released before it goes.
#
# Throws (does not run unlocked) when the lock's parent directory is not
# writable: a heavy run that believes it is serialised while it is not is the
# exact failure this file exists to prevent.
with_heavy_lock() {
  local lock_path=${1:?lock path is required}
  shift
  if [[ ${1:-} != -- || $# -lt 2 ]]; then
    printf 'usage: %s -- command [arg ...]\n' "${0##*/}" >&2
    return 64
  fi
  shift

  # Validated here, at the boundary, and bounded by more than taste: a ticket is
  # reclaimed 60 seconds past its owner's deadline
  # ({@link remove_dead_tickets}), which is only safe while the owner's own last
  # claim attempt lands within one poll of that deadline. A 300-second poll would
  # put a live waiter's final attempt four minutes past the instant everyone else
  # considers its ticket expired, and two runs would each believe they were next.
  # 30 is that grace halved.
  #
  # `10#` on the comparison, and it is the whole guard rather than a nicety: bash
  # arithmetic reads a leading zero as OCTAL, so a plain `((poll_seconds > 30))`
  # lets `031` past as 25 and then hands `sleep` the string `031`, which every
  # `sleep` reads as 31 — the bound defeated by notation. `08` is worse: it is not
  # a legal octal number, the comparison errors out, and an errored comparison is
  # a false one, so the guard passes.
  #
  # Zero is refused as well, and not for tidiness: a zero interval turns the wait
  # loop into a busy spin on the lock directory for the whole budget — half an
  # hour of `mkdir` and `date` per gate on a host that is already contended.
  #
  # Proof (observed 2026-09-16): with the check absent, `abc` and `300` were both
  # accepted in silence — `26a`/`26c … want exit 64, got 0`, the first surviving
  # only until the run had to wait, where `sleep abc` ends it with an unnamed 1.
  # With the check present but without `10#`, `031` and `08` were watched passing
  # too — `26e`/`26f … want exit 64, got 0`, the latter printing
  # `((: 08: value too great for base` on its way through — and `0` was accepted
  # before this refused it (`26h`) (bin/heavy-lock.test.sh, case 26).
  local poll_seconds=${HEAVY_LOCK_POLL_SECONDS:-5}
  if [[ ! $poll_seconds =~ ^[1-9][0-9]*$ ]] || ((10#$poll_seconds > 30)); then
    printf 'heavy lock: HEAVY_LOCK_POLL_SECONDS is %q; it must be a whole number of seconds from 1 to 30, written without a leading zero, because a queued ticket is reclaimed 60s past its deadline and a zero interval spins\n' \
      "$poll_seconds" >&2
    return 64
  fi

  # Captured BEFORE this function installs any trap of its own, so that both of
  # its traps chain the CALLER's trap rather than each other.
  local caller_exit_trap
  caller_exit_trap=$(trap -p EXIT)

  local lock_dir="$lock_path.d"
  local lock_parent
  lock_parent=$(dirname "$lock_dir")
  if [[ ! -d $lock_parent ]]; then
    printf 'heavy lock: %s does not exist\n' "$lock_parent" >&2
    return 70
  fi
  # Not what stops an unlocked run — `mkdir` already fails on an unwritable
  # parent and the claim returns 75. What this stops is the DIAGNOSIS being a
  # lie: without it a queueing run reads its own failed `mkdir` as "someone else
  # holds the lock", sleeps out its whole budget, and reports `held by pid ?`
  # about a lock nobody has and nobody can ever take.
  #
  # Proof: replacing this condition with `false` was watched turning a
  # `HEAVY_LOCK_WAIT_SECONDS=15` run against a chmod-500 directory from a 0s
  # exit-70 into a 16s spin ending in `held by pid ?` — a 30-minute budget would
  # have spun 30 minutes (bin/heavy-lock.test.sh, case 5).
  if [[ ! -w $lock_parent ]]; then
    printf 'heavy lock: %s is not writable; refusing to run unlocked\n' "$lock_parent" >&2
    return 70
  fi

  local queue_dir="$lock_path.queue"
  prepare_ticket_queue "$queue_dir" || return $?

  # The ticket goes in BEFORE the first claim attempt, so a run that takes a free
  # lock is ordered against a waiter that arrives during that same instant rather
  # than jumping it.
  #
  # The start time is read BEFORE the stamp the ticket is named after, so a
  # ticket can never claim to have started after the instant it was ordered by.
  local ticket_started
  ticket_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local ticket_stamp
  ticket_stamp=$(read_epoch_nanoseconds) || return $?
  local ticket_name="$ticket_stamp-$$"
  # Derived from the stamp this ticket is ORDERED by rather than from a second
  # clock reading: the two cannot then disagree, and the queue needs no more
  # clock than the one it already refused to run without. `10#` because a stamp
  # is read as a literal and a leading zero would make bash read it as octal.
  local ticket_deadline=$((10#$ticket_stamp / 1000000000 + ${HEAVY_LOCK_WAIT_SECONDS:-0}))
  local ticket_path="$queue_dir/$ticket_name"
  # Written under a DOT name and renamed into place. `> "$ticket_path"` creates
  # the file and `printf` fills it, so a reader landing between the two saw a
  # ticket with no label and refused it as malformed — a refusal caused by
  # nothing but timing. `*` does not match a dotfile and `mv` within one
  # directory is atomic, so a ticket under its real name is always a complete
  # ticket. A draft left by a run killed mid-write is invisible to every glob
  # here and is removed by this run's own trap.
  local ticket_draft="$queue_dir/.draft-$ticket_name"

  # Expanded into the trap string now, and quoted with `printf %q` rather than
  # `${var@Q}`, for the two reasons the release trap below records: a deferred
  # expansion reads a dead function-local under `set -u`, and `@Q` is a syntax
  # error on the bash 3.2 macOS ships. A leaked ticket is worse than a leaked
  # lock — the lock is reclaimed from its dead pid, but a ticket nobody removes
  # holds the head of the queue until it expires.
  #
  # Set BEFORE the ticket is written, so a run interrupted mid-write leaves
  # neither the draft nor the ticket behind.
  #
  # Proof (observed 2026-09-16): installing `true` in place of the removal was
  # watched leaving the ticket of a run REFUSED at its wait budget in the queue —
  # `16d: a refused run left 1 ticket(s) in the queue`, where it would have gone
  # on ordering waiters behind a process that had already given up
  # (bin/heavy-lock.test.sh, case 16d).
  install_release_trap '' "$ticket_path" "$ticket_draft" "$caller_exit_trap"
  printf 'pid %s\nlabel %s\nstarted %s\ndeadline %s\ncommand %s\n' \
    "$$" "${HEAVY_LOCK_LABEL:-unlabeled}" "$ticket_started" "$ticket_deadline" "$*" >"$ticket_draft"
  mv "$ticket_draft" "$ticket_path"

  local enqueued_at=$SECONDS
  local deadline=$((SECONDS + ${HEAVY_LOCK_WAIT_SECONDS:-0}))
  local claim_status tickets_ahead
  local tickets_ahead_at_arrival=
  while true; do
    remove_dead_tickets "$queue_dir" || return $?
    tickets_ahead=$(count_tickets_ahead "$queue_dir" "$ticket_name") || return $?
    if [[ -z $tickets_ahead_at_arrival ]]; then
      tickets_ahead_at_arrival=$tickets_ahead
    fi
    claim_status=0
    if [[ $tickets_ahead -eq 0 ]]; then
      claim_heavy_lock "$lock_dir" || claim_status=$?
    else
      # Someone arrived first and is still alive. Their turn, even if `mkdir`
      # would succeed for us right now — that instant is exactly the lottery.
      #
      # Proof (observed 2026-09-16): this branch is the whole change, and the
      # code without it is what shipped. Against a holder released while the
      # first waiter's five-second poll slept and the second's one-second poll
      # did not, the second waiter took the lock it queued for second —
      # `8: waiters are served in arrival order: want 'a b ', got 'b a '`
      # (bin/heavy-lock.test.sh, case 8).
      claim_status=75
    fi
    [[ $claim_status -eq 0 ]] && break
    [[ $claim_status -ne 75 ]] && return "$claim_status"
    if ((SECONDS >= deadline)); then
      # **The refusal names the reason it refused.** A waiter that gives up
      # because someone was ahead of it used to report `is held by pid ?`: the
      # lock is free at that instant, nobody holds it, and the one fact that
      # explains the refusal — who is in front, and which lane they are — was the
      # fact the message did not carry.
      #
      # Proof (observed 2026-09-16): printing the holder line unconditionally,
      # which is what shipped, was watched reporting
      # `heavy lock: /tmp/…bash.d is held by pid ?` for a run refused behind one
      # live ticket (bin/heavy-lock.test.sh, case 20b).
      if [[ $tickets_ahead -gt 0 ]]; then
        printf 'heavy lock: gave up after %ss behind %s tickets: %s\n' \
          "$((SECONDS - enqueued_at))" "$tickets_ahead" \
          "$(describe_tickets_ahead "$queue_dir" "$ticket_name")" >&2
      else
        printf 'heavy lock: %s is held by pid %s\n' "$lock_dir" "$(cat "$lock_dir/holder" 2>/dev/null || echo '?')" >&2
      fi
      return 75
    fi
    # `HEAVY_LOCK_POLL_SECONDS` exists so a test can make two waiters poll at
    # different rates and pin WHO gets the lock rather than who woke up first.
    # Production leaves it at 5; the value was validated and bounded at the top of
    # this function, where the reason for the bound is written down.
    sleep "$poll_seconds"
  done

  # Out of the queue the moment the lock is ours: the ticket's only job is to
  # order waiters, and a holder that kept its own would block every one of them
  # for as long as it holds — a gate's fifteen minutes.
  #
  # Proof (observed 2026-09-16): removing this line was watched leaving the
  # holder's own ticket in the queue for the whole run (`tickets while held: 1 ->
  # 1789542873547664968-1922461`, the holder's own pid) — `16e: a run holding the
  # lock kept its own ticket, which blocks every waiter behind it`. The release
  # trap still cleans it afterwards, which is why 16b alone cannot see this
  # (bin/heavy-lock.test.sh, case 16e).
  rm -f "$ticket_path"
  printf 'heavy lock: waited %ss behind %s tickets\n' \
    "$((SECONDS - enqueued_at))" "$tickets_ahead_at_arrival" >&2

  # Released on every exit path including SIGINT/SIGTERM. `exec` cannot be used
  # here for that reason: an exec'd command leaves no shell to run the trap, and
  # the lock outlives the run it was protecting.
  #
  # The path is expanded NOW, into the trap string. A single-quoted trap defers
  # the expansion to exit time, when `lock_dir` is a dead function-local — under
  # `set -u` that aborts the trap and leaks the lock on every run.
  #
  # `printf %q` rather than `${lock_dir@Q}`: macOS ships bash 3.2 as /bin/bash,
  # where `@Q` is a syntax error that likewise leaks the lock on every run.
  # The ticket paths are passed here too, although the claim above already
  # removed the ticket: this trap replaces the waiting one, and leaving them out
  # would mean a run interrupted between the two removals keeps its place in a
  # queue it has already left. The caller's own EXIT trap is chained by
  # {@link install_release_trap} rather than replaced.
  install_release_trap "$lock_dir" "$ticket_path" "$ticket_draft" "$caller_exit_trap"

  local run_status=0
  "$@" || run_status=$?
  return "$run_status"
}
