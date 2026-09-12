#!/usr/bin/env bash
# Negative tests for `bin/dev.sh`'s two guards.
#
# The seam is PATH, not an option: each case puts a fake `bunx` in front of the
# real one and lets the script run exactly the command line it always runs.
# Nothing here can ask `bin/dev.sh` to behave differently from the way a
# developer or the dev container invokes it.
#
# Both guards have been watched failing with the guard deliberately removed; the
# injected fault and what it printed are recorded in the `Proof:` comments in
# `bin/dev.sh`.
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dev_sh="$repo_root/bin/dev.sh"
failures=0
ports_sh="$repo_root/bin/dev-ports.sh"

# A `bunx` that prints one coloured line to each stream and exits as told, so a
# case can choose whether nx "died" without waiting on a real dev server, which
# never exits at all.
make_fake_bunx() {
  local dir=$1 code=$2
  mkdir -p "$dir"
  cat >"$dir/bunx" <<FAKE
#!/usr/bin/env bash
# \$PPID is the shell that ran us: with \`exec\` that is bin/dev.sh's own pid,
# and without it an extra subshell sits in between.
printf '%s\n' "\$*" >"$dir/argv"
printf '%s\n' "\$PPID" >"$dir/parent"
printf '\033[32mfake nx up\033[39m\n'
printf '\033[31mfake nx warning\033[39m\n' >&2
exit $code
FAKE
  chmod +x "$dir/bunx"
}

# A port nobody is serving, taken from the kernel rather than guessed: bind 0,
# read what that got, and let it go. A guessed high port is a case that passes
# for the wrong reason the day something else happens to hold it.
free_port() {
  bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); console.log(s.port); s.stop(true);'
}

# Serves a port until `stop_listener` is called, and prints the port. This is
# the fault the preflight is about, injected for real: a socket in LISTEN on a
# port the dev stack wants.
listener_pid=''
start_listener() {
  local dir=$1 waited=0
  cat >"$dir/listener.ts" <<'TS'
const server = Bun.serve({ port: 0, fetch: () => new Response('busy') });
await Bun.write(String(process.env['PORT_FILE']), String(server.port));
TS
  PORT_FILE="$dir/port" bun "$dir/listener.ts" >"$dir/listener.log" 2>&1 &
  listener_pid=$!
  # Bounded, then give up loudly: a silent wait here would turn "the listener
  # never came up" into "the port was free", which is the answer under test.
  while [[ ! -s "$dir/port" ]]; do
    waited=$((waited + 1))
    if (( waited > 100 )); then
      printf 'listener never bound a port\n' >&2
      exit 1
    fi
    sleep 0.1
  done
  cat "$dir/port"
}

stop_listener() {
  [[ -n $listener_pid ]] || return 0
  kill "$listener_pid" 2>/dev/null || :
  wait "$listener_pid" 2>/dev/null || :
  listener_pid=''
}

check() {
  local name=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$name" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# Every case that is not about the port preflight names a port nothing is
# serving, so a dev server running on this machine cannot decide its result.
free_pair="fe-01:$(free_port)"

run_case() {
  local tmp=$1 code=$2 log=$3
  shift 3
  make_fake_bunx "$tmp/bin" "$code"
  PATH="$tmp/bin:$PATH" WBS_DEV_LOG="$log" WBS_DEV_PORTS="$free_pair" \
    bash "$dev_sh" "$@" >"$tmp/stdout" 2>"$tmp/stderr"
}

# The nx target the fake was actually asked for.
asked_target() {
  sed -E 's/.*run-many -t ([^ ]+).*/\1/' "$1/bin/argv"
}

# 1. The captured file is written, and it is what the run printed.
tmp=$(mktemp -d)
run_case "$tmp" 0 "$tmp/logs/dev.log"
check 'captured file exists' 'yes' "$([[ -f "$tmp/logs/dev.log" ]] && echo yes || echo no)"
check 'captured file has the output' 'yes' \
  "$(grep -q 'fake nx up' "$tmp/logs/dev.log" && echo yes || echo no)"
rm -rf "$tmp"

# 2. Colour reaches the terminal and never reaches the file.
#    Proof target: the `awk` strip in bin/dev.sh.
tmp=$(mktemp -d)
run_case "$tmp" 0 "$tmp/dev.log"
check 'terminal stream keeps colour' 'yes' \
  "$(grep -q $'\033\[' "$tmp/stdout" && echo yes || echo no)"
check 'captured file has no escape bytes' 'yes' \
  "$(grep -q $'\033\[' "$tmp/dev.log" && echo no || echo yes)"
rm -rf "$tmp"

# 3. A dead nx is a failed run.
#    Proof target: `pipefail` in bin/dev.sh.
tmp=$(mktemp -d)
run_case "$tmp" 3 "$tmp/dev.log"
check 'a failing nx exits non-zero' '3' "$?"
rm -rf "$tmp"

# 4. Without the variable nothing is captured, because the deployed container
#    runs this path and must keep the behaviour it had before this file existed.
tmp=$(mktemp -d)
make_fake_bunx "$tmp/bin" 0
PATH="$tmp/bin:$PATH" WBS_DEV_PORTS="$free_pair" bash "$dev_sh" \
  >"$tmp/stdout" 2>"$tmp/stderr"
check 'default path writes no log' 'yes' \
  "$([[ -z "$(find "$tmp" -name '*.log' -print -quit)" ]] && echo yes || echo no)"
rm -rf "$tmp"

# 5. The flag swaps ONLY be-01's entrypoint, through one run-many.
#    Proof target: the `--local-solver` branch in bin/dev.sh.
tmp=$(mktemp -d)
run_case "$tmp" 0 "$tmp/dev.log" --local-solver
check 'local solver target' 'serve-local-solver' "$(asked_target "$tmp")"
check 'local solver keeps one nx invocation' '1' "$(wc -l <"$tmp/bin/argv" | tr -d ' ')"
check 'local solver runs all four tiers' 'yes' \
  "$(grep -q -- '--projects=be-01,gw-01,fe-01,mcp-01' "$tmp/bin/argv" && echo yes || echo no)"
rm -rf "$tmp"

# 6. No argument is still the ordinary supervised dev stack, because that path
#    is the dev container's CMD.
#    Proof target: `target=serve` in bin/dev.sh.
tmp=$(mktemp -d)
run_case "$tmp" 0 "$tmp/dev.log"
check 'default target' 'serve' "$(asked_target "$tmp")"
rm -rf "$tmp"

# 7. An argument this script does not understand stops before nx runs at all.
#    Proof target: the usage branch in bin/dev.sh.
tmp=$(mktemp -d)
make_fake_bunx "$tmp/bin" 0
# No `set -e` juggling: this suite runs without errexit on purpose, and turning
# it on here aborted the whole file at the next deliberately-failing case.
refused=0
PATH="$tmp/bin:$PATH" WBS_DEV_PORTS="$free_pair" bash "$dev_sh" --nonsense \
  >"$tmp/stdout" 2>"$tmp/stderr" || refused=$?
check 'unknown argument exits 2' '2' "$refused"
check 'unknown argument never reaches nx' 'yes' \
  "$([[ -f "$tmp/bin/argv" ]] && echo no || echo yes)"
rm -rf "$tmp"

# 8. A dead nx is still a failed run in local-solver mode.
#    Proof target: `pipefail`, reached through the new argument path.
tmp=$(mktemp -d)
failed=0
run_case "$tmp" 3 "$tmp/dev.log" --local-solver || failed=$?
check 'local solver nx failure propagates' '3' "$failed"
rm -rf "$tmp"

# 9. A served port stops the run before nx is invoked at all.
#    Proof target: the preflight call in bin/dev.sh.
tmp=$(mktemp -d)
held=$(start_listener "$tmp")
make_fake_bunx "$tmp/bin" 0
refused=0
PATH="$tmp/bin:$PATH" WBS_DEV_PORTS="fe-01:$held" bash "$dev_sh" \
  >"$tmp/stdout" 2>"$tmp/stderr" || refused=$?
check 'a served dev port exits 1' '1' "$refused"
check 'a served dev port never reaches nx' 'yes' \
  "$([[ -f "$tmp/bin/argv" ]] && echo no || echo yes)"
check 'the refusal names the port' 'yes' \
  "$(grep -q "$held" "$tmp/stderr" && echo yes || echo no)"
check 'the refusal names the tier' 'yes' \
  "$(grep -q 'fe-01' "$tmp/stderr" && echo yes || echo no)"
stop_listener
rm -rf "$tmp"

# 10. The same run, with that one port free, reaches nx.
#     Without this the case above passes for a script that refuses everything.
tmp=$(mktemp -d)
make_fake_bunx "$tmp/bin" 0
PATH="$tmp/bin:$PATH" WBS_DEV_PORTS="fe-01:$(free_port)" bash "$dev_sh" \
  >"$tmp/stdout" 2>"$tmp/stderr"
check 'free dev ports reach nx' 'serve' "$(asked_target "$tmp")"
rm -rf "$tmp"

# 11. The preflight refuses a served port and accepts a free one, asked
#     directly — dev.sh is not the only caller, and `bun run dev:ports` is the
#     way a developer asks the question by hand.
tmp=$(mktemp -d)
held=$(start_listener "$tmp")
refused=0
bash "$ports_sh" "fe-01:$held" >"$tmp/stdout" 2>"$tmp/stderr" || refused=$?
check 'dev-ports refuses a served port' '1' "$refused"
accepted=0
bash "$ports_sh" "fe-01:$(free_port)" >"$tmp/stdout" 2>"$tmp/stderr" || accepted=$?
check 'dev-ports accepts a free port' '0' "$accepted"
stop_listener
rm -rf "$tmp"

# 12. Resolution reads the port each tier is configured to bind, and says so
#     rather than guessing when a tier has no configured port.
tmp=$(mktemp -d)
mkdir -p "$tmp/apps/be-01" "$tmp/apps/gw-01" "$tmp/apps/mcp-01"
printf 'PORT=3101\nDB_PATH=x\n' >"$tmp/apps/be-01/.env"
printf 'BE_URL=http://x\n' >"$tmp/apps/gw-01/.env"
resolved=$(bash "$ports_sh" --resolve --apps-dir "$tmp/apps" 2>"$tmp/stderr")
check 'resolves the configured port' 'yes' \
  "$(grep -qx 'be-01:3101' <<<"$resolved" && echo yes || echo no)"
check 'a tier with no PORT is not guessed at' 'yes' \
  "$(grep -q '^gw-01:' <<<"$resolved" && echo no || echo yes)"
check 'a tier with no PORT is reported' 'yes' \
  "$(grep -q 'gw-01' "$tmp/stderr" && echo yes || echo no)"
check 'a tier with no .env is reported' 'yes' \
  "$(grep -q 'mcp-01' "$tmp/stderr" && echo yes || echo no)"
check 'fe-01 has no .env and is still checked' 'yes' \
  "$(grep -qx 'fe-01:4200' <<<"$resolved" && echo yes || echo no)"
rm -rf "$tmp"

# 13. An unreadable .env is not a tier without a port. Both branches exist in
#     resolve_ports, so both are watched here.
tmp=$(mktemp -d)
mkdir -p "$tmp/apps/be-01"
printf 'PORT=3101\n' >"$tmp/apps/be-01/.env"
chmod 000 "$tmp/apps/be-01/.env"
refused=0
bash "$ports_sh" --resolve --apps-dir "$tmp/apps" >"$tmp/stdout" 2>"$tmp/stderr" || refused=$?
check 'an unreadable .env is refused' '1' "$refused"
check 'the refusal says unreadable' 'yes' \
  "$(grep -q 'unreadable' "$tmp/stderr" && echo yes || echo no)"
chmod 600 "$tmp/apps/be-01/.env"
rm -rf "$tmp"

# 14. The check path stops at a file it cannot read, before probing anything.
#     Exit 1 alone does not say this: an unreadable `.env` makes the `sed` fail
#     too, and a busy port would also exit 1. What separates the two is whether
#     any port was probed at all.
tmp=$(mktemp -d)
mkdir -p "$tmp/apps/be-01"
printf 'PORT=3101\n' >"$tmp/apps/be-01/.env"
chmod 000 "$tmp/apps/be-01/.env"
held=$(start_listener "$tmp")
refused=0
PORT="$held" bash "$ports_sh" --apps-dir "$tmp/apps" \
  >"$tmp/stdout" 2>"$tmp/stderr" || refused=$?
check 'the check path refuses an unreadable .env' '1' "$refused"
check 'no port is probed once resolution refuses' 'yes' \
  "$(grep -q 'already being served' "$tmp/stderr" && echo no || echo yes)"
stop_listener
chmod 600 "$tmp/apps/be-01/.env"
rm -rf "$tmp"

# 15. This checkout's own four tiers, through the path bin/dev.sh actually
#     calls. What each tier must do depends on whether it is configured here:
#     `.env` is gitignored, so a developer who has run `bun run dev:setup` has
#     three of them and a fresh clone — CI included — has none. A tier is either
#     in the checked set or named as unconfigured; being in neither is a tier
#     that has fallen out of the loop, which is the fault this case is about.
#
#     Asserting the ports unconditionally is what this case did first, and it
#     passed here and failed in CI on `be-01 is in the checked set · expected:
#     yes · actual: no` — a claim about the developer's machine, made about a
#     checkout that has no `.env` to read.
#
#     Proof: with `mcp-01` removed from the loop in `resolve_ports`, this case
#     failed on `mcp-01 is checked or named as unconfigured · expected: yes ·
#     actual: no` in a checkout that has the three `.env` files, and the same
#     comparison run against an empty apps tree — the shape CI checks out —
#     answered `no` there too.
tmp=$(mktemp -d)
resolved=$(bash "$ports_sh" --resolve 2>"$tmp/stderr")
for tier in be-01 gw-01 mcp-01 fe-01; do
  if grep -q "^$tier:[0-9]" <<<"$resolved"; then
    accounted=yes
  elif grep -q "^$tier: " "$tmp/stderr"; then
    accounted=yes
  else
    accounted=no
  fi
  check "$tier is checked or named as unconfigured" 'yes' "$accounted"
done
rm -rf "$tmp"

if [[ $failures -gt 0 ]]; then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall checks passed\n'
