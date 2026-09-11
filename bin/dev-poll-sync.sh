#!/usr/bin/env bash
# Extract and run the requested commit's deployer outside the checkout it may reset.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo 'usage: dev-poll-sync.sh <source-checkout> <installed-bin-dir> <bun> <target-sha> <bun-version>' >&2
  exit 2
fi

SRC=$1
BIN=$2
BUN=$3
SHA=$4
EXPECTED_BUN_VERSION=$5

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing invalid target SHA: $SHA" >&2
  exit 2
fi
if [[ ! "$EXPECTED_BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "refusing invalid managed Bun version: $EXPECTED_BUN_VERSION" >&2
  exit 2
fi

mkdir -p "$BIN"
# Commit candidates are recovery snapshots, not an archive. Bound inode use on
# the durable host while leaving recent targets available for diagnosis. The
# pattern also retires the single-file `sync.<sha>.ts` candidates written
# before 2026-09-07 and their interrupted `.XXXXXXXX` siblings.
find "$BIN" -mindepth 1 -maxdepth 1 -name 'sync.*' -mtime +7 -exec rm -rf -- {} +

# Reclaiming commit-derived snapshots does not depend on the interpreter. Keep
# it ahead of these refusals so a broken or interrupted managed-Bun handoff
# cannot also pin old candidates while the operator repairs the installation.
if [ ! -x "$BUN" ]; then
  echo "refusing: missing managed Bun $EXPECTED_BUN_VERSION at $BUN; install it with the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi
if [ "$("$BUN" --version)" != "$EXPECTED_BUN_VERSION" ]; then
  echo "refusing: managed Bun at $BUN does not match $EXPECTED_BUN_VERSION from .bun-version; after a version bump, reinstall the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi

# The candidate is the target's complete committed tree, checked out detached
# at the exact SHA from a clone that shares the checkout's objects. Two things
# need the whole tree rather than the deployer's module graph alone:
#
# - The deployer reaches the deploy contract through the `@wbs/*` tsconfig
#   paths, and Bun resolves those from the tsconfig nearest the importing
#   file. A bare `sync.ts` copied into $BIN has none: every tick on h2puni
#   failed on `Cannot find module '@wbs/deploy-contract'` the day that copy
#   was first installed (2026-09-07).
# - A solver-affecting target publishes its `be` image from its own build
#   context (TASK-326): Dockerfile, publisher, supervisor unit and lockfile
#   as the target commit has them, with a HEAD that answers the target SHA.
#   A narrower archive executes while a later Dagger snapshot silently comes
#   from the older live checkout.
#
# Reading from the fetched target, rather than the checkout's pre-reset tree,
# is the recovery boundary. A broken target deployer can refuse this attempt,
# but its repaired successor is materialized on the next tick and can deploy
# itself — with the contract it was written against, not the one the checkout
# still has. The candidate still runs sync.ts, so solver, restart, recreate
# and post-reset HEAD checks are never bypassed.
CANDIDATE="$BIN/sync.${SHA}"
CANDIDATE_NEXT=''
cleanup_candidate() {
  if [ -n "$CANDIDATE_NEXT" ]; then rm -rf -- "$CANDIDATE_NEXT"; fi
}
trap cleanup_candidate EXIT HUP INT TERM
CANDIDATE_NEXT=$(mktemp -d "$BIN/sync.${SHA}.XXXXXXXX")
git clone --quiet --shared --no-checkout "$SRC" "$CANDIDATE_NEXT"
git -C "$CANDIDATE_NEXT" checkout --quiet --detach "$SHA"
# NO INSTALL IS LINKED IN, AND THAT IS THE CONTRACT (TASK-376).
#
# Until 2026-09-08 this linked `$SRC/node_modules` into the candidate. The
# checkout's install is pinned to whatever commit the checkout last reset to,
# which is by definition not the target being deployed. So the borrowed link
# had two failure modes and no success mode worth keeping: a package the
# target added is missing, or — worse, because it is silent — a package the
# target bumped resolves to the pre-reset version. Either way the new deployer
# needs an install that can only arrive through the new deployer, which is the
# bootstrap deadlock the candidate tree exists to break.
#
# The answer is that the deployer's import graph is out of bounds for
# third-party packages: relative imports, the `@wbs/*` aliases the tree
# carries, and Bun/Node builtins only. That is what `sync.ts` already is
# (`@wbs/deploy-contract` plus `bun`), and it is now enforced rather than
# assumed. Bun's own resolver is the enforcement: bundling the candidate's
# deployer resolves the whole transitive graph without running it, and with no
# `node_modules` in or above the candidate, any bare specifier that is not a
# builtin cannot resolve.
#
# The guard is two questions, because "it resolved" is not the property that
# matters — "it resolved to a file the candidate carries" is.
#
# 1. `--reject-unresolved`. Bun's default is `--allow-unresolved='*'`: a static
#    bare import fails the build, but an opaque `await import(name)` or
#    `require(name)` is waved straight through. Without the flag a deployer
#    passes this guard and still carries a runtime third-party dependency,
#    which is the exact silence the borrowed symlink had. The cost is that
#    every specifier must be statically analysable, including a computed
#    `node:fs` — a real restriction on the deployer, taken deliberately,
#    because an opaque specifier is precisely what cannot be checked here.
# 2. The resolved input set must live inside the candidate. Resolving is not
#    the same as staying home: `/home/puni1/wbs-dev/src/node_modules/x`, or
#    enough `../`, resolves perfectly well against the pinned checkout this
#    task exists to stop borrowing from. So the build is run from inside the
#    candidate and its metafile inputs are audited; anything absolute or above
#    the candidate refuses the tick.
#
# What neither question covers, stated rather than implied: code assembled at
# run time by `eval` or `new Function` is invisible to any build-time graph,
# and so is any process the deployer SPAWNS. The graph checked here is the one
# `exec` below starts; a child the deployer runs from this tree — the Dagger
# publisher on a solver-affecting tick — resolves for itself, against a tree
# that has no install. docs/runbook-dev-deploy.md says what that means.
#
# The cost is one extra Bun invocation per tick, ahead of a deploy that takes
# orders of magnitude longer — and `dev-poll.sh` exits before this loader
# entirely on a no-change tick, so it is only paid when a target is pending.
RESOLVE_OUT="$CANDIDATE_NEXT/.resolve"
RESOLVE_META="$CANDIDATE_NEXT/.resolve.json"
if ! (cd "$CANDIDATE_NEXT" && "$BUN" build --target=bun --reject-unresolved \
  --outdir="$RESOLVE_OUT" --metafile="$RESOLVE_META" \
  ./tools/tool-devsync/src/sync.ts) > "$CANDIDATE_NEXT/.resolve.log" 2>&1; then
  echo "refusing target $SHA: the deployer's import graph does not resolve inside the extracted candidate." >&2
  echo "The dev deployer may import only relative files, @wbs/* aliases and Bun/Node builtins, with statically analysable specifiers; it runs before any install for this commit exists. See docs/runbook-dev-deploy.md." >&2
  cat "$CANDIDATE_NEXT/.resolve.log" >&2
  exit 1
fi
# The build ran with the candidate as its working directory, so an input that
# escaped it is exactly one that is absolute or starts with `../`.
if ! WBS_RESOLVE_META="$RESOLVE_META" "$BUN" -e '
const meta = JSON.parse(require("fs").readFileSync(process.env.WBS_RESOLVE_META, "utf8"));
const outside = Object.keys(meta.inputs ?? {}).filter(
  (p) => p.startsWith("/") || p === ".." || p.startsWith("../"),
);
if (outside.length) {
  console.error(outside.join("\n"));
  process.exit(1);
}
' > "$CANDIDATE_NEXT/.resolve.log" 2>&1; then
  echo "refusing target $SHA: the deployer resolves files outside the extracted candidate." >&2
  echo "Every file the dev deployer imports must be one the candidate tree carries; a path into the pinned checkout is the stale install this guard exists to refuse. See docs/runbook-dev-deploy.md." >&2
  cat "$CANDIDATE_NEXT/.resolve.log" >&2
  exit 1
fi
# The guard's scratch is removed so the tree the deployer sees is the clean
# target tree, exactly as `git checkout --detach` left it.
#
# Nothing in sync.ts enforces that — `grep status tools/tool-devsync/src/sync.ts`
# is empty, and a comment here once claimed otherwise. What holds the line is
# `poller.test.ts`'s complete-tree case, whose probing Bun runs
# `git status --porcelain` in the candidate and exits 44 `target tree is dirty`;
# deleting this `rm -rf` was watched failing there. Stated rather than implied,
# because a cleanup whose reason is a check that does not exist is one edit away
# from being dropped as redundant.
rm -rf -- "$RESOLVE_OUT" "$RESOLVE_META" "$CANDIDATE_NEXT/.resolve.log"
# Two ticks on one target race to the same name. The loser discards its own
# clean detached clone and runs the winner's, which the commit hash makes
# byte-identical; a tree only ever appears under the final name complete, by
# rename.
if mv -T "$CANDIDATE_NEXT" "$CANDIDATE" 2>/dev/null; then
  CANDIDATE_NEXT=''
else
  rm -rf -- "$CANDIDATE_NEXT"
  CANDIDATE_NEXT=''
fi
trap - EXIT HUP INT TERM
# Proof: poller.test.ts requires both the target Docker build inputs and this
# working directory to resolve inside the immutable candidate.
cd "$CANDIDATE"
exec "$BUN" "$CANDIDATE/tools/tool-devsync/src/sync.ts" "$SHA"
