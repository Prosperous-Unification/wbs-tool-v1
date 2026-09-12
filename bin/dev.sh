#!/usr/bin/env bash
# The four dev tiers, optionally capturing what they print to a file.
#
# **Capture is opt-in, and the default path `exec`s.** This script is not only a
# developer's `bun run dev`: it is the dev container's CMD
# (`deploy/dev-src/Dockerfile`, `deploy/dev-src/compose.yml`). With
# `WBS_DEV_LOG` unset, nx REPLACES this shell, so the deployed container keeps
# the process tree and signal handling it had before this file existed — no
# extra PID between the container's init and nx, and SIGTERM still reaching the
# watchers rather than a wrapper that would have to forward it. The Dockerfile
# already records one incident of this tree dying for a smaller reason.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# `--local-solver` swaps only WHICH entrypoint be-01 starts: `serve-local-solver`
# runs `src/dev/main.ts`, which builds the local solver spawner, while the other
# three tiers carry an identically-named alias of their ordinary `serve` so this
# stays ONE `run-many` and one foreground nx process. Job control here would put
# failure collection, signal forwarding and child cleanup into a script whose
# default path deliberately has none — and that default path is the dev
# container's CMD.
#
# The argument is not a solver-mode switch. Production's `main.ts` builds the
# supervisor spawner unconditionally and never imports `src/dev/`; no value of
# this flag reaches it.
#
# Proof: assigning `target=serve` in the `--local-solver` branch failed
# `bin/dev.test.sh`'s `local solver target · expected: serve-local-solver ·
# actual: serve`; deleting the usage branch failed `unknown argument exits 2 ·
# expected: 2 · actual: 0` beside `unknown argument never reaches nx · actual:
# no`. The fake `bunx` proves the shell wiring only — that nx can resolve all
# four tasks was checked separately with `--graph=stdout`, which listed
# be-01/fe-01/gw-01/mcp-01 `:serve-local-solver`, and listed **three** with
# mcp-01's alias deleted.
target=serve
if (( $# > 0 )); then
  if (( $# != 1 )) || [[ $1 != --local-solver ]]; then
    printf 'usage: bin/dev.sh [--local-solver]\n' >&2
    exit 2
  fi
  target=serve-local-solver
fi

# Refuse before nx, while there is still one place to say why.
#
# A tier whose port is already served does not announce itself as such from the
# nx summary: vite exits in 710ms under `strictPort` and is listed as a task
# that completed beside three Continuous ones. The preflight names the port, the
# tier and the process holding it. Its own reasoning is in bin/dev-ports.sh.
#
# Proof: with this line removed and a listener bound to the port under test,
# `bin/dev.test.sh`'s `a served dev port exits 1 · expected: 1 · actual: 0`
# failed beside `a served dev port never reaches nx · expected: yes · actual:
# no` — nx started the whole stack over a port that was already taken.
"$repo_root/bin/dev-ports.sh"

args=(run-many -t "$target" "--projects=be-01,gw-01,fe-01,mcp-01")

if [[ -z "${WBS_DEV_LOG:-}" ]]; then
  exec bunx nx "${args[@]}"
fi

mkdir -p "$(dirname "$WBS_DEV_LOG")"

# Colour reaches the terminal and never reaches the file: `tee` writes the
# untouched stream to stdout, and the process substitution writes a stripped
# copy. Only CSI sequences are stripped, which is what nx, vite and pino emit
# here; an OSC title sequence would survive, and no tier writes one.
#
# `awk` rather than `sed`, because line-buffering is `-u` on GNU sed and `-l` on
# the BSD sed macOS ships, while `fflush()` is spelled the same in both awks.
# Without it the file lags a full block behind the screen, which makes a log
# read during a live run describe a moment that has already passed.
#
# Proof: replacing the process substitution with a plain `tee "$WBS_DEV_LOG"`
# failed `bin/dev.test.sh`'s `captured file has no escape bytes · expected: yes
# · actual: no`, with `terminal stream keeps colour` still green beside it.
strip_csi='{ gsub(/\033\[[0-9;?]*[a-zA-Z]/, ""); print; fflush() }'

# `pipefail` is what makes a dead nx a failed run: without it this pipeline
# reports `tee`'s status, which is 0 whenever the file could be written, and a
# container whose servers died would exit 0 and never be restarted.
#
# Proof: `set -eu` in place of `set -euo pipefail` failed `bin/dev.test.sh`'s
# `a failing nx exits non-zero · expected: 3 · actual: 0` — the run reporting
# success because `tee` had written the file it was asked for.
bunx nx "${args[@]}" 2>&1 | tee >(awk "$strip_csi" >"$WBS_DEV_LOG")
