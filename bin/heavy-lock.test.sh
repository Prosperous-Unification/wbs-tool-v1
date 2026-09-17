#!/usr/bin/env bash
# Negative tests for the host-wide heavy-work lock.
#
# Every case here has been watched FAILING with its guard deliberately broken;
# the injected fault and what it printed are recorded in the `Proof:` comment
# beside the guard in `heavy-lock-lib.sh`. Cases 2, 5, 6 and 8-26 carry a proof —
# the rest are contract checks. Several of those faults are not injected ones but
# the code that shipped: case 8's lottery, case 17's pid-only liveness, case 21's
# and 25's test-before-read, case 22's unisolated release trap.
#
# Runs the whole suite under bash 3.2 (macOS `/bin/bash`) as well as whatever
# `bash` resolves to, because the first two bugs in this file were a trap that
# only leaked under `set -u` and a `${var@Q}` that is a syntax error on 3.2.
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock_lib="$repo_root/bin/heavy-lock-lib.sh"

# The library's own entry point, given the lock path as its first argument.
#
# **Not `bin/with-heavy-lock.sh` with an environment override**, which is what
# this suite did until `tool-dagger/src/heavy-lock.test.ts` pointed out that a
# caller able to choose its own lock path is a caller able to opt out of the
# lock. The production wrapper takes no path and no override; the seam is this
# argument, which only a test passes.
run_locked() {
  local sh=$1 lock=$2
  shift 2
  # All three knobs are forwarded EXPLICITLY. A `VAR=x run_locked …` prefix sets
  # them for this function, but POSIX leaves it unspecified whether a function
  # call's prefix is exported to commands the function then runs — and bash does
  # not export it, so the queueing cases silently ran with the default 0 and were
  # refused instead of queueing. The two added here would fail the same way: the
  # arrival-order case is meaningless if its second waiter polls at the default
  # rate, and the status case has nothing to read if the labels never arrive.
  # shellcheck disable=SC2016 # Single quotes are the point: this string is a
  # script for the inner shell, whose `$1` and `$@` are its own arguments and
  # must not be expanded here.
  local inner='source "$1"; shift; with_heavy_lock "$@"'
  HEAVY_LOCK_WAIT_SECONDS="${HEAVY_LOCK_WAIT_SECONDS:-0}" \
    HEAVY_LOCK_POLL_SECONDS="${HEAVY_LOCK_POLL_SECONDS:-5}" \
    HEAVY_LOCK_LABEL="${HEAVY_LOCK_LABEL:-unlabeled}" \
    "$sh" -c "$inner" heavy-lock-test "$lock_lib" "$lock" -- "$@"
}

# The queue report, through the same lock-path seam every case above uses.
#
# `bin/with-heavy-lock.sh status` is the production route and takes no path, so
# running THAT here would report on the canonical host-wide lock — the one a real
# gate may be holding while this suite runs. Case 11 pins the wiring by reading
# the wrapper instead.
run_status() {
  local sh=$1 lock=$2
  # shellcheck disable=SC2016 # Single quotes are the point: `$1`/`$@` belong to
  # the inner shell, not to this one.
  local inner='source "$1"; shift; report_heavy_lock_status "$@"'
  "$sh" -c "$inner" heavy-lock-status-test "$lock_lib" "$lock"
}

# Start a run in the background and leave `$!` pointing at the shell that is
# actually running `with_heavy_lock`, which is what a signal has to reach.
#
# `run_locked` is a function, and a backgrounded function call is a subshell that
# may or may not exec its last command in place — so `$!` there is a pid a
# signalling case cannot reason about. Here the shell IS the background process.
start_signalable_run() {
  local sh=$1 lock=$2 wait_seconds=$3 poll_seconds=$4 label=$5
  shift 5
  # shellcheck disable=SC2016 # Single quotes are the point: this string is a
  # script for the inner shell, whose `$1` and `$@` are its own arguments.
  HEAVY_LOCK_WAIT_SECONDS="$wait_seconds" \
    HEAVY_LOCK_POLL_SECONDS="$poll_seconds" \
    HEAVY_LOCK_LABEL="$label" \
    "$sh" -c 'source "$1"; shift; with_heavy_lock "$@"' \
    heavy-lock-signal-test "$lock_lib" "$lock" -- "$@" &
}

count_queued_tickets() {
  local lock=$1 queued=0 ticket
  for ticket in "$lock.queue"/*; do
    [[ -e $ticket ]] && queued=$((queued + 1))
  done
  printf '%s\n' "$queued"
}

# A ticket file in the shape `with_heavy_lock` writes one, for a case that needs
# a ticket it controls: `$1` path, `$2` pid, `$3` lane label, `$4` deadline.
#
# The line ORDER is the contract, not decoration: the library reads the label off
# line 2 and the deadline off line 4, so that a queued command containing a line
# of its own beginning `label ` cannot contribute a second one.
write_ticket_fixture() {
  local path=$1 pid=$2 label=$3 deadline=$4
  printf 'pid %s\nlabel %s\nstarted 2001-09-09T01:46:40Z\ndeadline %s\ncommand sleep\n' \
    "$pid" "$label" "$deadline" >"$path"
}

# An epoch second $1 seconds from now, for a fixture's deadline.
epoch_seconds_from_now() {
  printf '%s\n' "$(($(date +%s) + $1))"
}

# Block until the lock at $1 is held AND its holder has left the queue, or fail
# saying it never was.
#
# Both halves are load-bearing. `claim_heavy_lock` writes its pid AFTER `mkdir`,
# so waiting on the directory alone would let the next waiter queue against a
# holder that has not recorded itself yet — and the holder deletes its own ticket
# AFTER writing that pid, so a poll landing in between leaves the holder's ticket
# in the queue, where `await_queued_tickets … 1` counts it as the first waiter's.
# The next waiter then starts before the first has enqueued and the two stamps
# race: watched as `8: waiters are served in arrival order: want 'a b ', got
# 'b a '` on a suite whose only fault was that window.
await_holder_recorded() {
  local lock=$1 polls=0
  while [[ ! -s $lock.d/holder ]]; do
    if [[ $polls -ge 100 ]]; then
      fail "no holder appeared at $lock.d in 10s"
      return 1
    fi
    sleep 0.1
    polls=$((polls + 1))
  done
}

await_lock_held() {
  local lock=$1 polls=0
  await_holder_recorded "$lock" || return 1
  while [[ $(count_queued_tickets "$lock") -ne 0 ]]; do
    if [[ $polls -ge 100 ]]; then
      fail "the holder of $lock.d never left the queue in 10s"
      return 1
    fi
    sleep 0.1
    polls=$((polls + 1))
  done
}

# Block until $2 tickets are queued at lock $1, or fail saying how many there are.
#
# **Arrival order is what these cases assert, so arrival is OBSERVED rather than
# inferred from a sleep.** A waiter launched a second after another one still
# stamps the older ticket if the host is slow enough to start it — and then the
# case fails for a reason that is about the host, not the lock.
await_queued_tickets() {
  local lock=$1 want=$2 polls=0
  while [[ $(count_queued_tickets "$lock") -lt $want ]]; do
    if [[ $polls -ge 100 ]]; then
      fail "waited 10s for $want tickets at $lock.queue and saw $(count_queued_tickets "$lock")"
      return 1
    fi
    sleep 0.1
    polls=$((polls + 1))
  done
}
failures=0

fail() {
  printf '  FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() { printf '  ok: %s\n' "$1"; }

# One exact line somewhere in $2, which is how the report's format is pinned
# without pinning the order of lines around it.
expect_line() {
  local want=$1 got=$2 what=$3
  if printf '%s\n' "$got" | grep -qxF "$want"; then
    pass "$what"
  else
    fail "$what: no line '$want' in: $got"
  fi
}

expect_status() {
  local want=$1 got=$2 what=$3
  if [[ $got -eq $want ]]; then pass "$what (exit $got)"; else fail "$what: want exit $want, got $got"; fi
}

run_suite() {
  local sh=$1
  local lock
  lock="${TMPDIR:-/tmp}/wbs-heavy-lock-test.$$.$(basename "$sh")"
  rm -rf "$lock"*

  # A pid that is certainly dead, spawned and reaped here rather than written as
  # a big constant. `999999` was the constant, and on these hosts
  # `kernel.pid_max` is 4194304: the pids in this suite's own output are already
  # past a million, so `999999` is a pid the kernel may well have handed to
  # something. Every case that needs "the owner is gone" would then quietly
  # become a case about a live process.
  local dead_pid
  "$sh" -c 'exit 0' &
  dead_pid=$!
  wait "$dead_pid"
  printf '\n== %s\n' "$("$sh" --version | head -1)"

  local status

  status=0
  run_locked "$sh" "$lock" true || status=$?
  expect_status 0 "$status" "1a: a plain run succeeds"
  if [[ -d $lock.d ]]; then fail "1b: the lock leaked"; else pass "1b: the lock is released"; fi

  # Case 2 — the guard is `is_process_alive`. Broken, the second run starts.
  run_locked "$sh" "$lock" sleep 6 &
  local holder_job=$!
  sleep 1
  status=0
  run_locked "$sh" "$lock" true || status=$?
  expect_status 75 "$status" "2: a concurrent run is refused"
  wait "$holder_job"
  if [[ -d $lock.d ]]; then fail "2b: the lock leaked"; else pass "2b: the lock is released"; fi

  run_locked "$sh" "$lock" sleep 6 &
  holder_job=$!
  sleep 1
  local started=$SECONDS
  status=0
  HEAVY_LOCK_WAIT_SECONDS=60 run_locked "$sh" "$lock" true || status=$?
  local waited=$((SECONDS - started))
  expect_status 0 "$status" "3a: a queueing run gets its turn"
  # 3s against a 6s holder. The queueing run polls every 5s, so a genuine queue
  # cannot come back under ~5 — but the holder is a real process and a loaded host
  # can be slow to start it, which shortens the window without meaning anything.
  # A run that did not queue at all returns in milliseconds, so 3 still separates
  # the two cases by an order of magnitude.
  if [[ $waited -ge 3 ]]; then pass "3b: it waited ${waited}s for the holder"; else fail "3b: it waited only ${waited}s, so it did not queue"; fi
  wait "$holder_job"

  status=0
  run_locked "$sh" "$lock" bash -c 'exit 42' || status=$?
  expect_status 42 "$status" "4: the wrapped command's exit code is forwarded"

  # Case 5 — the guard is the `-w` check. Broken, this spins out the whole
  # budget and then lies about who holds the lock.
  local readonly_dir="${TMPDIR:-/tmp}/wbs-heavy-lock-ro.$$"
  mkdir -p "$readonly_dir" && chmod 500 "$readonly_dir"
  started=$SECONDS
  status=0
  HEAVY_LOCK_WAIT_SECONDS=15 run_locked "$sh" "$readonly_dir/lock" true || status=$?
  waited=$((SECONDS - started))
  expect_status 70 "$status" "5a: an unwritable lock directory throws"
  # 10s, not 5, against a 15s budget. The fault this watches turned a 0s exit-70
  # into a **16s** spin, so anything below the budget still catches it — and the
  # tighter bound was load-sensitive: this suite runs on a machine that may have a
  # full Nx gate on it, where a "0s" operation can take several. A negative whose
  # verdict depends on how busy the host is reports on the host, not on the code.
  if [[ $waited -lt 10 ]]; then pass "5b: it threw at once rather than spinning (${waited}s)"; else fail "5b: it spun ${waited}s against a lock nobody can take"; fi
  chmod 700 "$readonly_dir" && rm -rf "$readonly_dir"

  # Case 6 — the guard is the pid-format check. Broken, it reclaims a lock whose
  # holder it could not read and runs anyway.
  mkdir -p "$lock.d" && printf 'not-a-pid\n' >"$lock.d/holder"
  status=0
  run_locked "$sh" "$lock" true || status=$?
  expect_status 70 "$status" "6: a holder file that is not a pid throws"
  rm -rf "$lock.d"

  mkdir -p "$lock.d" && printf '%s\n' "$dead_pid" >"$lock.d/holder"
  status=0
  run_locked "$sh" "$lock" true || status=$?
  expect_status 0 "$status" "7: a lock held by a dead pid is reclaimed"

  # Case 8 — arrival order, and the reason the poll rates differ.
  #
  # A arrives first and polls every 5s; B arrives a second later and polls every
  # 1s. The holder releases at ~4s, while A is still inside its first sleep and B
  # is not — so under the poll-first lottery B takes the lock it queued for
  # second, every time. Watched doing exactly that before the queue existed
  # ("8: waiters are served in arrival order: want 'a b ', got 'b a '"), which is
  # what makes this case a negative rather than a hopeful race.
  local order_log="$lock.order"
  rm -f "$order_log"
  run_locked "$sh" "$lock" sleep 4 &
  local holder_job=$!
  await_lock_held "$lock"
  # shellcheck disable=SC2016 # Single quotes are the point: `$1` and `$2` are
  # the inner shell's own arguments, passed after it.
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_LABEL=a \
    run_locked "$sh" "$lock" bash -c 'printf "%s\n" "$1" >>"$2"' arrival-a a "$order_log" &
  local first_waiter=$!
  await_queued_tickets "$lock" 1
  # shellcheck disable=SC2016 # Single quotes are the point: see waiter a above.
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_POLL_SECONDS=1 HEAVY_LOCK_LABEL=b \
    run_locked "$sh" "$lock" bash -c 'printf "%s\n" "$1" >>"$2"' arrival-b b "$order_log" &
  local second_waiter=$!
  await_queued_tickets "$lock" 2
  wait "$holder_job" "$first_waiter" "$second_waiter"
  local arrival_order
  arrival_order=$(tr '\n' ' ' <"$order_log")
  if [[ $arrival_order == 'a b ' ]]; then
    pass "8: waiters are served in arrival order"
  else
    fail "8: waiters are served in arrival order: want 'a b ', got '$arrival_order'"
  fi

  # Case 9 — the guard is `remove_dead_tickets`. A waiter killed with SIGKILL
  # runs no trap, so its ticket outlives it; leave that ticket in place and the
  # queue never moves again, which is the starvation this change exists to end,
  # in a worse form. The stamp is 19 digits and older than any real one, so this
  # ticket is unambiguously ahead of the run below.
  local stderr_log="$lock.stderr"
  local dead_ticket_name="1000000000000000000-$dead_pid"
  mkdir -p "$lock.queue"
  # An hour of budget left, so what gets this ticket reclaimed is unambiguously
  # the dead pid rather than the expiry case 17 covers.
  write_ticket_fixture "$lock.queue/$dead_ticket_name" "$dead_pid" dead "$(epoch_seconds_from_now 3600)"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "9a: a dead waiter's ticket does not hold the queue"
  if [[ -e $lock.queue/$dead_ticket_name ]]; then
    fail "9b: the dead ticket was left in the queue"
  else
    pass "9b: the dead ticket was removed"
  fi
  if grep -q "removing ticket $dead_ticket_name from dead pid $dead_pid" "$stderr_log"; then
    pass "9c: the removal named the ticket it removed"
  else
    fail "9c: the removal did not name the ticket: $(cat "$stderr_log")"
  fi

  # Case 10 — the guard is `prepare_ticket_queue`, and the mode is 300 rather
  # than 000 deliberately: a WRITE-ONLY queue is the dangerous one. The ticket
  # still gets written, and the glob over a directory this process cannot read
  # expands to nothing — so the run reads a queue with nobody in it and claims
  # the lock straight over the older live ticket sitting there. Mutual exclusion
  # still works; the arrival order this file promises silently does not. The
  # planted ticket names this suite's own pid, which is alive, so it cannot be
  # dismissed as dead.
  local ahead_marker="$lock.ahead-marker"
  local live_ticket_name="1000000000000000000-$$"
  rm -f "$ahead_marker"
  write_ticket_fixture "$lock.queue/$live_ticket_name" "$$" planted "$(epoch_seconds_from_now 3600)"
  chmod 300 "$lock.queue"
  status=0
  # shellcheck disable=SC2016 # Single quotes are the point: `$0` is the marker
  # path this passes to the inner shell, not a variable of this one.
  run_locked "$sh" "$lock" bash -c 'printf "RAN AHEAD OF THE QUEUE\n" >"$0"' "$ahead_marker" \
    2>"$stderr_log" || status=$?
  expect_status 70 "$status" "10a: an unreadable queue directory throws"
  if grep -q "queue directory $lock.queue is not readable and writable" "$stderr_log"; then
    pass "10b: the refusal named the queue directory"
  else
    fail "10b: the refusal did not name the queue directory: $(cat "$stderr_log")"
  fi
  if [[ -e $ahead_marker ]]; then
    fail "10c: it ran ahead of a queue it could not read"
  else
    pass "10c: it never ran ahead of a queue it could not read"
  fi
  # And the other half of the same guard: a queue it can read but not write is
  # equally unusable, and without the check the ticket redirect fails with a bare
  # `Permission denied` and exit 1 — a lock failure reported as a command failure.
  chmod 500 "$lock.queue"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "10d: an unwritable queue directory throws"
  chmod 700 "$lock.queue" && rm -f "$lock.queue/$live_ticket_name"

  # Case 11 — `status` is the only way a queued lane can see why it is waiting.
  # The pids are matched as digits rather than against `$!`: bash may exec the
  # inner shell in place of the subshell it forked, and a case that asserts which
  # of the two pids it got is asserting an optimisation, not the report.
  HEAVY_LOCK_LABEL=holder run_locked "$sh" "$lock" sleep 5 &
  holder_job=$!
  await_lock_held "$lock"
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_LABEL=first run_locked "$sh" "$lock" true &
  first_waiter=$!
  await_queued_tickets "$lock" 1
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_POLL_SECONDS=1 HEAVY_LOCK_LABEL=second \
    run_locked "$sh" "$lock" true &
  second_waiter=$!
  await_queued_tickets "$lock" 2
  local queue_report
  queue_report=$(run_status "$sh" "$lock")
  local holder_pattern='^heavy lock: holder pid [0-9]+ label holder$'
  local first_pattern='^heavy lock: waiter pid [0-9]+ label first age [0-9]+s budget [0-9]+s left$'
  local second_pattern='^heavy lock: waiter pid [0-9]+ label second age [0-9]+s budget [0-9]+s left$'
  if [[ $(printf '%s\n' "$queue_report" | sed -n 1p) =~ $holder_pattern ]]; then
    pass "11a: status names the holder and its lane"
  else
    fail "11a: status did not name the holder and its lane: $queue_report"
  fi
  if [[ $(printf '%s\n' "$queue_report" | sed -n 2p) =~ $first_pattern ]]; then
    pass "11b: the waiter that arrived first is listed first, with its age"
  else
    fail "11b: the first waiter is not listed first: $queue_report"
  fi
  if [[ $(printf '%s\n' "$queue_report" | sed -n 3p) =~ $second_pattern ]]; then
    pass "11c: the waiter that arrived second is listed second, with its age"
  else
    fail "11c: the second waiter is not listed second: $queue_report"
  fi
  local reported_lines
  reported_lines=$(printf '%s\n' "$queue_report" | grep -c '^heavy lock: ')
  if [[ $reported_lines -eq 3 ]]; then
    pass "11d: status prints one line per entry"
  else
    fail "11d: status printed $reported_lines lines for a holder and two waiters: $queue_report"
  fi
  wait "$holder_job" "$first_waiter" "$second_waiter"
  # The wiring, read off the wrapper: production takes no lock path, so the only
  # thing this suite can check about it is that `status` reaches the report with
  # the canonical path and nothing else.
  # shellcheck disable=SC2016 # Single quotes are the point: this is the literal
  # text being searched for in another file, not an expansion.
  if grep -qF 'report_heavy_lock_status "$(resolve_heavy_lock_path)"' "$repo_root/bin/with-heavy-lock.sh"; then
    pass "11e: bin/with-heavy-lock.sh status reports on the canonical lock"
  else
    fail "11e: bin/with-heavy-lock.sh does not report on the canonical lock"
  fi

  # Case 12 — the guard is `read_ticket_pid`. The tempting reading of a name it
  # cannot parse is "no live pid in there, so it is dead", which deletes a file
  # this code did not write on the strength of a name it could not read.
  printf 'stray\n' >"$lock.queue/note"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "12a: an unorderable name in the queue throws"
  if [[ -e $lock.queue/note ]]; then
    pass "12b: it left the file it could not identify alone"
  else
    fail "12b: it deleted a file it could not identify"
  fi
  rm -f "$lock.queue/note"

  # Case 13 — what `status` refuses. A report is read by a human deciding whether
  # to clear a lock by hand, so "nobody holds it" about a lock it could not read,
  # or a blank label for a waiter it could not read, is the one answer worse than
  # an error.
  rm -rf "$lock.d"
  mkdir -p "$lock.d" && printf '%s\n' "$dead_pid" >"$lock.d/holder" && printf 'held\n' >"$lock.d/label"
  chmod 000 "$lock.d"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "13a: status throws on a lock directory it cannot read"
  chmod 700 "$lock.d" && rm -rf "$lock.d"
  printf 'pid %s\nstarted 2001-09-09T01:46:40Z\ndeadline 4102444800\ncommand sleep\n' "$dead_pid" \
    >"$lock.queue/$dead_ticket_name"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "13b: status throws on a ticket that records no lane label"
  write_ticket_fixture "$lock.queue/$dead_ticket_name" "$dead_pid" dead 4102444800
  chmod 000 "$lock.queue/$dead_ticket_name"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "13c: status throws on a ticket it cannot read"
  chmod 600 "$lock.queue/$dead_ticket_name" && rm -f "$lock.queue/$dead_ticket_name"
  write_ticket_fixture "$lock.queue/$dead_ticket_name" "$dead_pid" dead 4102444800
  chmod 000 "$lock.queue"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "13d: status throws on a queue directory it cannot read"
  chmod 700 "$lock.queue" && rm -f "$lock.queue/$dead_ticket_name"

  # Case 14 — the guard is the 19-digit check in `read_epoch_nanoseconds`. BSD
  # `date` does not fail on `+%N`; it prints a literal `N`. A ticket named
  # `1758012345N-<pid>` sorts before every real ticket, so that host would hold
  # the head of the queue for ever while every check here still passed.
  local clockless_bin
  clockless_bin="${TMPDIR:-/tmp}/wbs-heavy-lock-clockless.$$.$(basename "$sh")"
  rm -rf "$clockless_bin"
  mkdir -p "$clockless_bin"
  local clockless_tool clockless_tool_path
  # `bash` is on this PATH for the PAYLOAD's sake, not the library's: without it
  # the run reaches its command and dies 127, and the marker below would then be
  # absent for a reason that has nothing to do with the clock.
  for clockless_tool in bash mkdir dirname cat rm sleep sed; do
    clockless_tool_path=$(type -P "$clockless_tool")
    if [[ -z $clockless_tool_path ]]; then
      fail "14: this image has no $clockless_tool, so the clockless PATH cannot be built"
    else
      ln -s "$clockless_tool_path" "$clockless_bin/$clockless_tool"
    fi
  done
  # Only `+%s%N` is broken, because only `+%s%N` is what BSD `date` gets wrong: it
  # answers every other format correctly. A fake that broke them all would refuse
  # for reasons this case is not about, and would hide it if the library grew a
  # second clock reading.
  local real_date
  real_date=$(type -P date)
  # shellcheck disable=SC2016 # Single quotes are the point: `$1` and `$@` belong
  # to the generated fake, not to this process.
  printf '#!/bin/sh\ncase "$1" in\n  +%%s%%N) printf "1758012345N\\n" ;;\n  *) exec %s "$@" ;;\nesac\n' \
    "$real_date" >"$clockless_bin/date"
  chmod 755 "$clockless_bin/date"
  local clockless_marker="$lock.clockless-marker"
  rm -f "$clockless_marker"
  status=0
  # shellcheck disable=SC2016 # Single quotes are the point: `$0` is the marker
  # path passed to the inner shell.
  PATH="$clockless_bin" run_locked "$sh" "$lock" \
    bash -c 'printf "RAN ON AN UNORDERABLE TICKET\n" >"$0"' "$clockless_marker" \
    2>"$stderr_log" || status=$?
  expect_status 70 "$status" "14a: a host with no nanosecond clock throws"
  if [[ -e $clockless_marker ]]; then
    fail "14b: it ran on a ticket it could not order"
  else
    pass "14b: it never ran on a ticket it could not order"
  fi
  if compgen -G "$lock.queue/*" >/dev/null; then
    fail "14c: it left a ticket it could not order: $(ls "$lock.queue")"
  else
    pass "14c: it queued no ticket it could not order"
  fi
  rm -rf "$clockless_bin"

  # Case 16 — the two leak paths, which are the queue's own failure mode: a
  # ticket that outlives the run that wrote it holds up every lane behind it
  # until something notices its pid is gone.
  rm -rf "$lock.queue"
  status=0
  run_locked "$sh" "$lock" true || status=$?
  expect_status 0 "$status" "16a: a successful run succeeds"
  if [[ $(count_queued_tickets "$lock") -eq 0 ]]; then
    pass "16b: a successful run leaves no ticket behind"
  else
    fail "16b: a successful run left $(count_queued_tickets "$lock") ticket(s) in the queue"
  fi
  run_locked "$sh" "$lock" sleep 3 &
  holder_job=$!
  # Only that the holder has recorded itself, NOT that the queue has drained:
  # what 16e asserts is the draining, so waiting for it here would assert it
  # against itself.
  await_holder_recorded "$lock"
  if [[ $(count_queued_tickets "$lock") -eq 0 ]]; then
    pass "16e: a run holding the lock is out of the queue it waited in"
  else
    fail "16e: a run holding the lock kept its own ticket, which blocks every waiter behind it"
  fi
  status=0
  HEAVY_LOCK_WAIT_SECONDS=0 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 75 "$status" "16c: a run refused at its wait budget is refused"
  if [[ $(count_queued_tickets "$lock") -eq 0 ]]; then
    pass "16d: a refused run takes its ticket with it"
  else
    fail "16d: a refused run left $(count_queued_tickets "$lock") ticket(s) in the queue"
  fi
  wait "$holder_job"

  # Case 17 — `kill -0` alone cannot decide a ticket is live, because pids are
  # recycled: a waiter killed with SIGKILL leaves a ticket whose pid the kernel
  # may hand to something unrelated minutes later, after which every lane queues
  # behind a ghost for ever. The fixture is the worst case — a pid that is
  # definitely alive (this suite's own) with a deadline that has passed.
  rm -rf "$lock.queue"
  mkdir -p "$lock.queue"
  local expired_ticket_name="1000000000000000000-$$"
  write_ticket_fixture "$lock.queue/$expired_ticket_name" "$$" ghost "$(epoch_seconds_from_now -120)"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "17a: a ticket past its wait budget does not hold the queue"
  if [[ -e $lock.queue/$expired_ticket_name ]]; then
    fail "17b: the expired ticket was left in the queue"
  else
    pass "17b: the expired ticket was removed"
  fi
  if grep -q "removing ticket $expired_ticket_name from pid $$, whose wait budget expired" "$stderr_log"; then
    pass "17c: the removal named the ticket and why it went"
  else
    fail "17c: the removal did not name the expired ticket: $(cat "$stderr_log")"
  fi
  # And the guard that reads it: a ticket with no deadline to read is unknown
  # state, not an expired one and not a live one.
  printf 'pid %s\nlabel ghost\nstarted 2001-09-09T01:46:40Z\ncommand sleep\n' "$$" \
    >"$lock.queue/$expired_ticket_name"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "17d: a ticket that records no deadline throws"
  if [[ -e $lock.queue/$expired_ticket_name ]]; then
    pass "17e: it left the ticket it could not read alone"
  else
    fail "17e: it deleted a ticket whose deadline it could not read"
  fi
  rm -f "$lock.queue/$expired_ticket_name"

  # Case 18 — what `status` must NOT refuse. Both windows below are ordinary:
  # `claim_heavy_lock` writes the holder pid after its `mkdir`, and a lock taken
  # by a build that predates the queue has no label file at all. A report that
  # exits 70 over either is a report nobody can leave running.
  rm -rf "$lock.d"
  mkdir -p "$lock.d"
  status=0
  local queue_report
  queue_report=$(run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "18a: status tolerates a lock dir whose holder is not written yet"
  expect_line 'heavy lock: holder claiming' "$queue_report" "18b: it says the holder is still claiming"
  printf '4321\n' >"$lock.d/holder"
  status=0
  queue_report=$(run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "18c: status tolerates a holder that recorded no lane label"
  expect_line 'heavy lock: holder pid 4321 label unlabeled (pre-queue holder)' "$queue_report" \
    "18d: it says the lane is unknown rather than refusing"
  # Unreadable is still unknown state, and each file is named separately.
  chmod 000 "$lock.d/holder"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "18e: status throws on a holder file it cannot read"
  chmod 600 "$lock.d/holder"
  printf 'held\n' >"$lock.d/label" && chmod 000 "$lock.d/label"
  status=0
  run_status "$sh" "$lock" >/dev/null 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "18f: status throws on a label file it cannot read"
  chmod 600 "$lock.d/label" && rm -rf "$lock.d"

  # Case 19 — a ticket appears under its real name only once it is complete.
  # `> "$ticket"` creates the file and `printf` fills it, so a `status` landing
  # between the two read an empty ticket and refused it as malformed — a refusal
  # triggered by nothing but timing. The library now writes a dot-named draft and
  # renames it, and `*` does not match a dotfile: the draft below stands for one
  # left by a run killed mid-write, and nothing may see it.
  rm -rf "$lock.queue"
  mkdir -p "$lock.queue"
  printf '' >"$lock.queue/.draft-1000000000000000000-$$"
  status=0
  queue_report=$(run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "19a: status ignores a half-written draft ticket"
  if [[ $(count_queued_tickets "$lock") -eq 0 ]]; then
    pass "19b: a draft ticket is not counted as queued"
  else
    fail "19b: a draft ticket was counted as queued"
  fi
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "19c: a draft ticket neither blocks a run nor throws"
  # The wiring, read off the library: production cannot be raced deterministically
  # here, so what this pins is that the visible name is published by `mv` rather
  # than by the redirect that produced the transient.
  # shellcheck disable=SC2016 # Single quotes are the point: this is the literal
  # text being searched for in another file, not an expansion.
  if grep -qF 'mv "$ticket_draft" "$ticket_path"' "$lock_lib"; then
    pass "19d: the ticket is published by rename, not by the redirect that writes it"
  else
    fail "19d: the ticket is not published by rename"
  fi
  rm -f "$lock.queue/.draft-1000000000000000000-$$"

  # Case 20 — the refusal has to name the reason it refused. A waiter that gives
  # up because someone was ahead of it used to report `is held by pid ?`: the
  # lock is free, nobody holds it, and the one fact that explains the refusal —
  # who was in front — was the fact the message did not carry.
  rm -rf "$lock.d" "$lock.queue"
  mkdir -p "$lock.queue"
  write_ticket_fixture "$lock.queue/$live_ticket_name" "$$" ahead-of-me "$(epoch_seconds_from_now 3600)"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 75 "$status" "20a: a waiter behind a live ticket is refused"
  if grep -q "gave up after [0-9]*s behind 1 tickets: ahead-of-me (pid $$)" "$stderr_log"; then
    pass "20b: the refusal names the tickets ahead and their lanes"
  else
    fail "20b: the refusal did not name the tickets ahead: $(cat "$stderr_log")"
  fi
  # A ticket that scans clean — live pid, readable deadline — but whose label
  # line is not there. `gone` and `unknown` are different facts about a ticket
  # ahead, and a reader deciding whether to wait for it needs to know which.
  printf 'pid %s\nstarted 2001-09-09T01:46:40Z\nunnamed\ndeadline %s\ncommand sleep\n' \
    "$$" "$(epoch_seconds_from_now 3600)" >"$lock.queue/$live_ticket_name"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 75 "$status" "20c: a waiter behind a ticket it cannot name is still refused"
  if grep -q "gave up after [0-9]*s behind 1 tickets: unknown (pid $$)" "$stderr_log"; then
    pass "20d: a ticket that is there but cannot be named is reported unknown"
  else
    fail "20d: a ticket that cannot be named is not reported unknown: $(cat "$stderr_log")"
  fi
  rm -f "$lock.queue/$live_ticket_name"

  # Case 21 — a ticket that leaves the queue while it is being READ.
  #
  # Every scan reads each ticket, and a ticket is claimed or reclaimed by someone
  # else at any moment: the file is simply gone by the time `sed` opens it. That
  # is ordinary, and it was being read as unknown state — exit 70, from a run
  # whose only misfortune was scanning a queue that was moving. Testing `-e`
  # first cannot close the window, because the command substitution forks before
  # its own test runs; the shim below makes the window certain instead of rare by
  # deleting the ticket it is asked to read and then reading it.
  rm -rf "$lock.d" "$lock.queue"
  mkdir -p "$lock.queue"
  local vanishing_bin
  vanishing_bin="${TMPDIR:-/tmp}/wbs-heavy-lock-vanishing.$$.$(basename "$sh")"
  rm -rf "$vanishing_bin"
  mkdir -p "$vanishing_bin"
  local vanishing_tool vanishing_tool_path
  for vanishing_tool in bash mkdir dirname cat rm mv sleep date; do
    vanishing_tool_path=$(type -P "$vanishing_tool")
    if [[ -z $vanishing_tool_path ]]; then
      fail "21: this image has no $vanishing_tool, so the vanishing PATH cannot be built"
    else
      ln -s "$vanishing_tool_path" "$vanishing_bin/$vanishing_tool"
    fi
  done
  local real_sed
  real_sed=$(type -P sed)
  # shellcheck disable=SC2016 # Single quotes are the point: `$arg` and `$@`
  # belong to the generated shim, not to this process.
  printf '#!/bin/sh\nfor arg do\n  case "$arg" in\n    *.queue/*) rm -f "$arg" ;;\n  esac\ndone\nexec %s "$@"\n' \
    "$real_sed" >"$vanishing_bin/sed"
  chmod 755 "$vanishing_bin/sed"
  write_ticket_fixture "$lock.queue/$live_ticket_name" "$$" vanishing "$(epoch_seconds_from_now 3600)"
  status=0
  PATH="$vanishing_bin" run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "21a: a ticket that vanishes mid-read does not fail the run"
  write_ticket_fixture "$lock.queue/$live_ticket_name" "$$" vanishing "$(epoch_seconds_from_now 3600)"
  status=0
  queue_report=$(PATH="$vanishing_bin" run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "21b: a ticket that vanishes mid-read does not fail status"
  if [[ $queue_report == *waiter* ]]; then
    fail "21c: status reported a waiter whose ticket had gone: $queue_report"
  else
    pass "21c: status leaves out the waiter whose ticket had gone"
  fi
  rm -rf "$vanishing_bin" "$lock.queue"

  # Case 22 — the release trap must eat neither the run's exit status nor the
  # caller's own cleanup.
  #
  # The trap runs `rm -rf` on the lock directory, and under `set -e` a failing
  # `rm` aborts the whole trap: the caller's chained EXIT trap never runs and the
  # shell exits 1 instead of with the status the run actually produced. The
  # fixture makes the removal fail the way a shared host does — the lock's parent
  # loses write permission while the run holds it — and asserts both halves.
  local stuck_root
  stuck_root="${TMPDIR:-/tmp}/wbs-heavy-lock-stuck.$$.$(basename "$sh")"
  rm -rf "$stuck_root"
  # The lock's parent is what the payload makes unwritable; the caller's cleanup
  # lives OUTSIDE it, because a fixture that also breaks the caller's own `rm`
  # proves nothing about whether it was reached.
  local stuck_parent="$stuck_root/locks"
  local caller_cleanup_dir="$stuck_root/caller-cleanup"
  mkdir -p "$stuck_parent" "$caller_cleanup_dir"
  # bin/h2puni-gate.sh's shape: an EXIT trap of its own, installed before the
  # lock, and a payload with an exit status worth keeping.
  # shellcheck disable=SC2016 # Single quotes are the point: every line is source
  # for the generated fixture, whose `$1`-`$4` are its own arguments.
  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'source "$1"' \
    'caller_cleanup_dir=$2' \
    'lock_parent=$4' \
    'trap '\''rm -rf -- "$caller_cleanup_dir"'\'' EXIT' \
    'payload() { chmod 500 "$lock_parent"; return 42; }' \
    'payload_status=0' \
    'with_heavy_lock "$3" -- payload || payload_status=$?' \
    'exit $payload_status' \
    >"$stuck_root/caller.sh"
  status=0
  "$sh" "$stuck_root/caller.sh" \
    "$lock_lib" "$caller_cleanup_dir" "$stuck_parent/stuck.lock" "$stuck_parent" \
    2>"$stderr_log" || status=$?
  expect_status 42 "$status" "22a: the run's exit status survives a release that could not finish"
  chmod 700 "$stuck_parent"
  if [[ -d $caller_cleanup_dir ]]; then
    fail "22b: a release that could not finish skipped the caller's EXIT trap"
  else
    pass "22b: the caller's EXIT trap ran even though the release could not finish"
  fi
  if grep -q "could not remove" "$stderr_log"; then
    pass "22c: the release said out loud what it could not remove"
  else
    fail "22c: the release did not say what it could not remove: $(cat "$stderr_log")"
  fi
  rm -rf "$stuck_root"

  # Case 23 — drafts from runs that were killed mid-write. A SIGKILLed run leaves
  # its `.draft-` file behind and runs no trap, and no ticket glob matches a
  # dotfile, so nothing would ever look at it again: one file per killed run, for
  # ever, on a host that is never cleaned by hand. The pid is in the name, which
  # is all the sweep needs.
  rm -rf "$lock.queue"
  mkdir -p "$lock.queue"
  local stale_draft=".draft-1000000000000000000-$dead_pid"
  local live_draft=".draft-1000000000000000000-$$"
  printf 'pid %s\n' "$dead_pid" >"$lock.queue/$stale_draft"
  printf 'pid %s\n' "$$" >"$lock.queue/$live_draft"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "23a: a stale draft does not fail a run"
  if [[ -e $lock.queue/$stale_draft ]]; then
    fail "23b: the draft from a dead pid was left behind for ever"
  else
    pass "23b: the draft from a dead pid was swept"
  fi
  if grep -q "removing draft ticket $stale_draft from dead pid $dead_pid" "$stderr_log"; then
    pass "23c: the sweep named the draft it removed"
  else
    fail "23c: the sweep did not name the draft: $(cat "$stderr_log")"
  fi
  if [[ -e $lock.queue/$live_draft ]]; then
    pass "23d: a draft from a live pid is left alone, because it is being written"
  else
    fail "23d: it swept a draft whose owner is still writing it"
  fi
  rm -f "$lock.queue/$live_draft"

  # Case 24 — the holder file read the same way, because it has the same window.
  #
  # `claim_heavy_lock` tested `-r` and then read: between the two, the holder can
  # release and `rm -rf` takes the file with it, so the read comes back empty and
  # the pid check calls a RELEASED lock corrupt. This was watched happening in
  # this suite with nothing injected — case 3a, `cat: …/holder: No such file or
  # directory`, `holder holds '', not a pid`, exit 70 where the queueing run
  # should simply have tried again. The `cat` shim makes that window certain.
  rm -rf "$lock.d" "$lock.queue"
  local racing_bin
  racing_bin="${TMPDIR:-/tmp}/wbs-heavy-lock-racing.$$.$(basename "$sh")"
  rm -rf "$racing_bin"
  mkdir -p "$racing_bin"
  local racing_tool racing_tool_path
  for racing_tool in bash mkdir dirname rm mv sleep date sed; do
    racing_tool_path=$(type -P "$racing_tool")
    if [[ -z $racing_tool_path ]]; then
      fail "24: this image has no $racing_tool, so the racing PATH cannot be built"
    else
      ln -s "$racing_tool_path" "$racing_bin/$racing_tool"
    fi
  done
  local real_cat
  real_cat=$(type -P cat)
  # shellcheck disable=SC2016 # Single quotes are the point: `$arg` and `$@`
  # belong to the generated shim, not to this process.
  printf '#!/bin/sh\nfor arg do\n  case "$arg" in\n    *.d/holder|*.d/label) rm -f "$arg" ;;\n  esac\ndone\nexec %s "$@"\n' \
    "$real_cat" >"$racing_bin/cat"
  chmod 755 "$racing_bin/cat"
  run_locked "$sh" "$lock" sleep 3 &
  holder_job=$!
  await_lock_held "$lock"
  status=0
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_POLL_SECONDS=1 PATH="$racing_bin" \
    run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "24a: a holder file that vanishes mid-read is retried, not called corrupt"
  wait "$holder_job"
  # The guards either side of that window, which the retry must not have eaten: a
  # holder file that is there and unreadable is still unknown state, and one that
  # is there and empty is a claim in progress rather than a corrupt lock.
  rm -rf "$lock.d"
  mkdir -p "$lock.d" && printf '4321\n' >"$lock.d/holder" && chmod 000 "$lock.d/holder"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "24b: an unreadable holder file still throws"
  chmod 600 "$lock.d/holder"
  printf '' >"$lock.d/holder"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 75 "$status" "24c: a holder file that is created but not yet written is a claim in progress"
  rm -rf "$lock.d"

  # Case 25 — `status` reads those same two files, and had the same window. It
  # tested and then `cat`ed, so a holder releasing in between killed the report
  # itself: `cat: …/holder: No such file or directory` and exit 1 under `set -e`,
  # from a command whose whole job is to be safe to run at any moment.
  mkdir -p "$lock.d"
  printf 'held\n' >"$lock.d/label"
  printf '%s\n' "$$" >"$lock.d/holder"
  status=0
  queue_report=$(PATH="$racing_bin" run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "25a: a holder file that vanishes mid-read does not kill the report"
  expect_line 'heavy lock: holder claiming' "$queue_report" \
    "25b: it reports a lock whose holder file has gone as one being claimed"
  # The other end of that race: the holder does not merely rewrite its files, it
  # takes the whole lock directory with it on release. A report reading through
  # that has no holder to name, and `none` is the truth rather than `claiming`.
  local vanishing_lock_bin
  vanishing_lock_bin="${TMPDIR:-/tmp}/wbs-heavy-lock-vanishing-dir.$$.$(basename "$sh")"
  rm -rf "$vanishing_lock_bin"
  mkdir -p "$vanishing_lock_bin"
  for racing_tool in bash mkdir dirname rm mv sleep date sed; do
    racing_tool_path=$(type -P "$racing_tool")
    if [[ -z $racing_tool_path ]]; then
      fail "25: this image has no $racing_tool"
    else
      ln -s "$racing_tool_path" "$vanishing_lock_bin/$racing_tool"
    fi
  done
  # shellcheck disable=SC2016 # Single quotes are the point: `$arg` and `$@`
  # belong to the generated shim, not to this process.
  printf '#!/bin/sh\nfor arg do\n  case "$arg" in\n    *.d/holder) rm -rf "${arg%%/holder}" ;;\n  esac\ndone\nexec %s "$@"\n' \
    "$real_cat" >"$vanishing_lock_bin/cat"
  chmod 755 "$vanishing_lock_bin/cat"
  mkdir -p "$lock.d"
  printf 'held\n' >"$lock.d/label"
  printf '%s\n' "$$" >"$lock.d/holder"
  status=0
  queue_report=$(PATH="$vanishing_lock_bin" run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "25c: a lock released mid-report does not kill the report"
  expect_line 'heavy lock: holder none' "$queue_report" \
    "25d: a lock whose directory has gone is reported as free, not as being claimed"
  rm -rf "$vanishing_lock_bin"

  # And the instant `claim_heavy_lock` answers with 75 in case 24c, seen from the
  # report's side: the holder file exists but has not been written yet.
  rm -rf "$lock.d"
  mkdir -p "$lock.d"
  printf 'held\n' >"$lock.d/label"
  printf '' >"$lock.d/holder"
  status=0
  queue_report=$(run_status "$sh" "$lock" 2>"$stderr_log") || status=$?
  expect_status 0 "$status" "25e: an empty holder file does not fail the report"
  expect_line 'heavy lock: holder claiming' "$queue_report" \
    "25f: an empty holder file is reported as a claim in progress, not as a holder with no pid"

  rm -rf "$racing_bin" "$lock.d"

  # Case 26 — `HEAVY_LOCK_POLL_SECONDS` is validated at the boundary, because the
  # expiry grace in `remove_dead_tickets` depends on it: a ticket is reclaimed 60s
  # past its owner's deadline, which is only safe while the owner's last claim
  # attempt lands within one poll of that deadline.
  status=0
  HEAVY_LOCK_POLL_SECONDS=abc run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 64 "$status" "26a: a poll interval that is not a number is refused"
  if grep -q 'HEAVY_LOCK_POLL_SECONDS' "$stderr_log"; then
    pass "26b: the refusal names the variable"
  else
    fail "26b: the refusal did not name the variable: $(cat "$stderr_log")"
  fi
  status=0
  HEAVY_LOCK_POLL_SECONDS=300 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 64 "$status" "26c: a poll interval longer than the expiry grace is refused"
  status=0
  HEAVY_LOCK_POLL_SECONDS=30 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 0 "$status" "26d: the longest safe poll interval is still allowed"
  # Bash arithmetic reads a leading zero as octal, so a bound written `((x > 30))`
  # lets `031` through as 25 and then hands `sleep` the string `031`, which is 31
  # seconds — the bound defeated by the notation. `08` is worse: it is not a legal
  # octal number at all, so the comparison errors out and the guard passes.
  status=0
  HEAVY_LOCK_POLL_SECONDS=031 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 64 "$status" "26e: a poll interval written with a leading zero is refused"
  status=0
  HEAVY_LOCK_POLL_SECONDS=08 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 64 "$status" "26f: a poll interval that is not a legal octal number is still refused"
  if grep -q 'HEAVY_LOCK_POLL_SECONDS' "$stderr_log"; then
    pass "26g: the leading-zero refusal names the variable too"
  else
    fail "26g: the leading-zero refusal did not name the variable: $(cat "$stderr_log")"
  fi
  # A zero poll is not a fast queue, it is a busy spin on the lock directory for
  # the whole wait budget — half an hour of `mkdir` for a gate.
  status=0
  HEAVY_LOCK_POLL_SECONDS=0 run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 64 "$status" "26h: a zero poll interval is refused"

  # Case 15 — the other half of `prepare_ticket_queue`: a queue path that is not a
  # directory. 15b is the assertion with teeth. Removing the refusal does not let
  # a run through — the readability check catches whatever it leaves behind — but
  # it makes every answer wrong: a plain file is refused as a directory that is
  # `not readable and writable`, and a lock whose queue has yet to be created is
  # refused the same way. A refusal that names the wrong thing sends the next
  # agent to chmod a path that needed removing.
  rm -rf "$lock.queue"
  printf 'not a queue\n' >"$lock.queue"
  status=0
  run_locked "$sh" "$lock" true 2>"$stderr_log" || status=$?
  expect_status 70 "$status" "15a: a queue path that is not a directory throws"
  if grep -q "cannot create the queue directory $lock.queue" "$stderr_log"; then
    pass "15b: the refusal named the path it could not use"
  else
    fail "15b: the refusal did not name the path: $(cat "$stderr_log")"
  fi
  rm -f "$lock.queue"

  # Case 27 — a signalled run releases AND EXITS.
  #
  # Watched on h2puni, not reasoned about: pid 4049358 survived `kill -TERM` and
  # stayed in the wait loop. Bash defers a trapped signal until the foreground
  # child returns, runs the handler, and then CONTINUES the script — so a waiter
  # sent TERM ran its release, deleted its own ticket, and kept polling as a
  # waiter with no ticket. It can then claim ahead of everyone who does have one:
  # the FIFO guarantee broken by the mechanism that was supposed to clean up
  # after it, and `kill` not stopping a run for any caller.
  local signal_marker="$lock.signal-marker"
  rm -f "$signal_marker"
  run_locked "$sh" "$lock" sleep 5 &
  holder_job=$!
  await_lock_held "$lock"
  # shellcheck disable=SC2016 # Single quotes are the point: `$0` is the marker
  # path passed to the inner shell.
  start_signalable_run "$sh" "$lock" 60 1 signalled \
    bash -c 'printf claimed >"$0"' "$signal_marker"
  local signalled_run=$!
  await_queued_tickets "$lock" 1
  local signalled_at=$SECONDS
  kill -TERM "$signalled_run"
  status=0
  wait "$signalled_run" || status=$?
  local signalled_for=$((SECONDS - signalled_at))
  expect_status 143 "$status" "27a: a queued waiter sent TERM exits 143"
  if [[ $signalled_for -le 3 ]]; then
    pass "27b: it left within one poll (${signalled_for}s)"
  else
    fail "27b: it took ${signalled_for}s to leave, which is not one poll"
  fi
  if [[ $(count_queued_tickets "$lock") -eq 0 ]]; then
    pass "27c: it took its ticket with it"
  else
    fail "27c: it left its ticket in the queue"
  fi
  wait "$holder_job"
  # The holder has released by now. A waiter that merely cleaned up and carried
  # on would take the free lock here, which is the observation that matters.
  sleep 2
  if [[ -e $signal_marker ]]; then
    fail "27d: the signalled waiter claimed the lock after it was told to stop"
  else
    pass "27d: the signalled waiter never claimed the lock"
  fi
  rm -f "$signal_marker"

  # A HOLDER is the other half, and the decision is that its command is not cut
  # short: the command is the work the lock exists to serialise, and killing it
  # from in here would leave whatever it was doing — a checkout, a build — in a
  # state nobody chose. Bash defers the trap until the command returns anyway; a
  # caller that wants the command dead signals the process group. What this
  # case pins is that the release and the exit still happen afterwards.
  local finished_marker="$lock.finished-marker"
  rm -f "$finished_marker"
  # shellcheck disable=SC2016 # Single quotes are the point: see above.
  start_signalable_run "$sh" "$lock" 0 5 term-holder \
    bash -c 'sleep 2; printf finished >"$0"' "$finished_marker"
  local signalled_holder=$!
  await_lock_held "$lock"
  kill -TERM "$signalled_holder"
  status=0
  wait "$signalled_holder" || status=$?
  expect_status 143 "$status" "27e: a holder sent TERM exits 143 once its command has finished"
  if [[ -e $finished_marker ]]; then
    pass "27f: the command the lock was protecting ran to completion"
  else
    fail "27f: the command was cut short by a signal aimed at the lock"
  fi
  if [[ -d $lock.d ]]; then
    fail "27g: the signalled holder leaked the lock"
  else
    pass "27g: the signalled holder released the lock"
  fi
  rm -f "$finished_marker"

  # INT gets the conventional 130, for the same reason TERM gets 143: a caller
  # reading an exit status can tell a signalled run from a refused one.
  #
  # **Job control on for this case, and the case is meaningless without it.** A
  # shell without job control sets SIGINT to IGNORE for every `&` job, and a
  # signal ignored on entry cannot be trapped — so `kill -INT` to a background
  # run is a no-op and this case would be testing the harness, not the lock.
  # Measured: the same run exits 0 after its sleep without `set -m` and 130 with
  # it. Monitor mode puts the run in its own process group with default
  # dispositions, which is the shape a person pressing Ctrl+C actually produces.
  run_locked "$sh" "$lock" sleep 5 &
  holder_job=$!
  await_lock_held "$lock"
  set -m
  start_signalable_run "$sh" "$lock" 60 1 interrupted true
  local interrupted_run=$!
  set +m
  await_queued_tickets "$lock" 1
  kill -INT "$interrupted_run"
  status=0
  wait "$interrupted_run" || status=$?
  expect_status 130 "$status" "27h: a queued waiter sent INT exits 130"
  wait "$holder_job"

  # And the caller's own EXIT trap runs EXACTLY once on a signal: the handler has
  # to run it (it exits, so the EXIT trap would never fire) without letting the
  # EXIT trap run it a second time. Counted rather than asserted by shape.
  local caller_log="$lock.caller-log"
  rm -f "$caller_log"
  # shellcheck disable=SC2016 # Single quotes are the point: every line is source
  # for the generated fixture, whose `$1`-`$3` are its own arguments.
  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'source "$1"' \
    'caller_log=$2' \
    'trap '\''printf "ran\n" >>"$caller_log"'\'' EXIT' \
    'with_heavy_lock "$3" -- sleep 30' \
    >"$lock.signalled-caller.sh"
  run_locked "$sh" "$lock" sleep 5 &
  holder_job=$!
  await_lock_held "$lock"
  HEAVY_LOCK_WAIT_SECONDS=60 HEAVY_LOCK_POLL_SECONDS=1 \
    "$sh" "$lock.signalled-caller.sh" "$lock_lib" "$caller_log" "$lock" &
  local signalled_caller=$!
  await_queued_tickets "$lock" 1
  kill -TERM "$signalled_caller"
  status=0
  wait "$signalled_caller" || status=$?
  expect_status 143 "$status" "27i: a signalled caller exits 143 through its own script"
  # No `|| printf 0` fallback: `grep -c` exits 1 when it counts zero, so on the
  # red path the fallback ran too and the substitution held `0` twice — the
  # comparison below then failed on its own operand rather than on the count.
  # Zero is an answer here, and grep has already printed it.
  local caller_runs
  caller_runs=$(grep -c '^ran$' "$caller_log" 2>/dev/null)
  if [[ $caller_runs -eq 1 ]]; then
    pass "27j: the caller's own EXIT trap ran exactly once"
  else
    fail "27j: the caller's own EXIT trap ran $caller_runs times"
  fi
  wait "$holder_job"
  rm -f "$caller_log" "$lock.signalled-caller.sh"

  rm -rf "$lock"*
}

# /bin/bash is 3.2 on macOS and is what a `#!/usr/bin/env bash` script gets when
# no newer bash is on PATH, so it is never skipped. The modern bash is probed by
# path rather than through `command -v bash`, which resolves to /bin/bash inside
# this script and silently ran the 3.2 suite twice.
run_suite /bin/bash
for modern_bash in /opt/homebrew/bin/bash /usr/local/bin/bash; do
  if [[ -x $modern_bash ]]; then
    run_suite "$modern_bash"
    break
  fi
done

printf '\n'
if [[ $failures -gt 0 ]]; then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all heavy-lock checks passed\n'
