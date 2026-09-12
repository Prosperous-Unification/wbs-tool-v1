#!/usr/bin/env bash
# Refuses to start the dev stack while a port one of its tiers needs is already
# being served.
#
# **Why a preflight rather than four servers reporting their own clash.** A held
# port does not read as a held port from the nx summary: `fe-01`'s vite sets
# `strictPort` (`apps/fe-01/vite.config.ts`, and deliberately, so the browser
# gate cannot silently measure 4201), so it exits in under a second and nx lists
# it as a task that *completed* in 710ms beside three that are Continuous — the
# shape of a finished build, not of a refusal. One orphaned vite from a previous
# session cost a morning that way on 2026-09-12.
#
# The probe is bash's own `/dev/tcp`, not `lsof`, because this script runs inside
# the dev container (`bin/dev.sh` is that image's CMD) and a preflight that needs
# a binary the image does not ship would turn a helpful check into a broken
# container. `lsof` is used only to NAME the holder once a port has already
# answered, which is why its absence costs a line of detail and never an answer.
#
# A connect is evidence of a listener and its absence is not evidence of a free
# port: only 127.0.0.1 is probed, so a server bound to ::1 alone is missed and
# the run proceeds exactly as it did before this file existed.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  printf 'usage: dev-ports.sh [--resolve] [--apps-dir <dir>] [<tier>:<port> ...]\n' >&2
  exit 2
}

# The port each tier will bind, as `<tier>:<port>` lines.
#
# be-01, gw-01 and mcp-01 parse `PORT` out of their own environment and have no
# default for it (`string.integer.parse` in each `config.ts`), so their `.env` is
# the only place that knows. fe-01 has no `.env`: vite reads `process.env.PORT`
# and falls back to 4200, and this reads the same two things in the same order.
#
# A tier with no configured port is reported and left out rather than guessed at.
# An UNREADABLE `.env` is a different thing from an absent one — it is a file
# this script cannot answer about — and stops the run.
resolve_ports() {
  local apps_dir=$1 tier env_file port
  for tier in be-01 gw-01 mcp-01; do
    env_file="$apps_dir/$tier/.env"
    if [[ ! -e $env_file ]]; then
      printf '%s: no %s, so it has no configured port to check\n' "$tier" "$env_file" >&2
      continue
    fi
    if [[ ! -r $env_file ]]; then
      printf 'unreadable environment file: %s\n' "$env_file" >&2
      exit 1
    fi
    port=$(sed -n -E 's/^PORT=([0-9]+)[[:space:]]*$/\1/p' "$env_file" | tail -n 1)
    if [[ -z $port ]]; then
      printf '%s: %s sets no PORT, so it has no configured port to check\n' "$tier" "$env_file" >&2
      continue
    fi
    printf '%s:%s\n' "$tier" "$port"
  done
  printf 'fe-01:%s\n' "${PORT:-4200}"
}

# Whether something answers a TCP connect on the loopback address.
port_is_served() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Everything known about who holds a port, printed under the refusal. Every line
# here is detail: the refusal itself has already been decided by the connect.
report_holder() {
  local port=$1 pid command
  if ! command -v lsof >/dev/null 2>&1; then
    printf '    no lsof on PATH, so the process cannot be named here\n' >&2
    return 0
  fi
  # lsof exits non-zero when nothing matches, which is a real outcome: the
  # holder can exit between the connect above and this line.
  pid=$(lsof -tnP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | head -n 1) || pid=''
  if [[ -z $pid ]]; then
    printf '    the port answered but nothing is listening on it now\n' >&2
    return 0
  fi
  command=$(ps -o command= -p "$pid") || command='(exited)'
  printf '    held by pid %s: %s\n' "$pid" "${command:0:100}" >&2
  printf '    free it with: kill %s\n' "$pid" >&2
}

mode=check
apps_dir=$repo_root/apps
while (($# > 0)); do
  case $1 in
    --resolve)
      mode=resolve
      shift
      ;;
    # Where the tiers' `.env` files live. The default is this checkout, and the
    # flag is how bin/dev.test.sh reaches the resolution both modes share
    # without a mode-000 file in the working tree.
    --apps-dir)
      (($# >= 2)) || usage
      apps_dir=$2
      shift 2
      ;;
    -*) usage ;;
    *) break ;;
  esac
done

if [[ $mode == resolve ]]; then
  (($# == 0)) || usage
  resolve_ports "$apps_dir"
  exit 0
fi

pairs=()
if (($# > 0)); then
  pairs=("$@")
elif [[ -n ${WBS_DEV_PORTS+x} ]]; then
  # The ports to check, overriding what the `.env` files say. This is the seam
  # `bin/dev.test.sh` runs its other cases through, so that a dev server on the
  # developer's machine cannot decide a case about argument parsing, and the
  # escape hatch for a checkout whose tiers are on shifted ports.
  #
  # Deliberate word splitting: this variable is a list of pairs.
  # shellcheck disable=SC2206
  pairs=($WBS_DEV_PORTS)
  if ((${#pairs[@]} == 0)); then
    printf 'WBS_DEV_PORTS is set and empty: no dev port is being checked\n' >&2
  fi
else
  # The substitution is assigned rather than piped into `mapfile`: a resolution
  # that refuses must stop the run, and a failure inside a process substitution
  # is a status `mapfile` never sees.
  #
  # Proof: with `mapfile -t pairs < <(resolve_ports ...)` in place of these two
  # lines, `the check path refuses an unreadable .env` failed on `expected: 1 ·
  # actual: 0`. The refusal was printed, its status died with the subshell, and
  # the run reported success having checked nothing — resolution stops at the
  # first tier it cannot answer for, so `pairs` was empty and the loop below had
  # nothing to say no about.
  resolved=$(resolve_ports "$apps_dir")
  mapfile -t pairs <<<"$resolved"
fi

served=0
for pair in "${pairs[@]}"; do
  tier=${pair%%:*}
  port=${pair##*:}
  if [[ -z $tier || -z $port || $tier == "$pair" || ! $port =~ ^[0-9]+$ ]]; then
    printf 'malformed <tier>:<port> pair: %s\n' "$pair" >&2
    exit 2
  fi
  if port_is_served "$port"; then
    served=$((served + 1))
    printf '%s cannot start: port %s is already being served\n' "$tier" "$port" >&2
    report_holder "$port"
  fi
done

if ((served > 0)); then
  printf 'refusing to start the dev stack with %d port(s) already served\n' "$served" >&2
  exit 1
fi
