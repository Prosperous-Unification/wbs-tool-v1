#!/usr/bin/env bash
set -euo pipefail

selection=${1:?candidate selection is required}
repository=${2:?candidate repository is required}
revision=${3:?candidate revision or base is required}

activation_root=${TOOL_WIKI_ACTIVATION_ROOT:-}
if [[ -z "$activation_root" ]] || [[ ! -e "$activation_root" ]]; then
  printf '%s\n' '{"schemaVersion":1,"status":"inactive","certified":false,"reason":"external activation root is not provisioned"}'
  exit 0
fi
if [[ ! -d "$activation_root" ]]; then
  printf 'tool-wiki lint: external activation root is not a directory\n' >&2
  exit 78
fi

candidate_root=$(cd -- "$repository" && pwd -P)
trusted_root=$(cd -- "$activation_root" && pwd -P)
case "$trusted_root/" in
  "$candidate_root/"*)
    printf 'tool-wiki lint: activation root must be outside the candidate repository\n' >&2
    exit 78
    ;;
esac

marker="$trusted_root/active-v1"
if [[ ! -e "$marker" ]]; then
  printf '%s\n' '{"schemaVersion":1,"status":"inactive","certified":false,"reason":"external activation marker is not provisioned"}'
  exit 0
fi
if [[ ! -f "$marker" ]] || [[ ! -r "$marker" ]] || [[ $(<"$marker") != 'tool-wiki-active-v1' ]]; then
  # Proof: gate-entrypoints.test.ts replaces this external marker with malformed bytes and
  # observes the production adapter fail instead of accepting candidate-owned rollout state.
  printf 'tool-wiki lint: active external rollout marker is missing, unreadable, or malformed\n' >&2
  exit 78
fi

read_trusted_path() {
  local descriptor=$1
  local label=$2
  if [[ ! -r "$descriptor" ]]; then
    printf 'tool-wiki lint: active rollout is missing readable %s\n' "$label" >&2
    exit 78
  fi
  local selected
  selected=$(<"$descriptor")
  if [[ "$selected" != /* ]] || [[ ! -r "$selected" ]]; then
    printf 'tool-wiki lint: active rollout has invalid %s\n' "$label" >&2
    exit 78
  fi
  printf '%s\n' "$selected"
}

trusted_cli=$(read_trusted_path "$trusted_root/validator-path" 'validator path')
if ! trusted_cli=$(realpath -- "$trusted_cli") || [[ ! -f "$trusted_cli" ]] || [[ ! -r "$trusted_cli" ]]; then
  printf 'tool-wiki lint: validator must resolve to a readable regular file\n' >&2
  exit 78
fi
case "$trusted_cli" in
  "$candidate_root"/*)
    # Proof: gate-entrypoints.test.ts points an external validator descriptor through a symlink
    # into the candidate and observes refusal before the candidate marker can be written.
    printf 'tool-wiki lint: validator must be outside the candidate repository\n' >&2
    exit 78
    ;;
esac
evidence=$(read_trusted_path "$trusted_root/evidence-path" 'evidence path')
# Proof: gate-entrypoints.test.ts removes and malforms the active external snapshotter descriptor;
# the production adapter refuses before any validator snapshot or candidate read can begin.
snapshotter=$(read_trusted_path "$trusted_root/snapshotter-path" 'snapshotter path')
if ! snapshotter=$(realpath -- "$snapshotter") || [[ ! -f "$snapshotter" ]] || [[ ! -r "$snapshotter" ]]; then
  printf 'tool-wiki lint: snapshotter must resolve to a readable regular file\n' >&2
  exit 78
fi
case "$snapshotter" in
  "$candidate_root"/*)
    printf 'tool-wiki lint: snapshotter must be outside the candidate repository\n' >&2
    exit 78
    ;;
esac
bun_path=$(command -v bun)
trusted_path=$(dirname -- "$bun_path"):/usr/bin:/bin

case "$selection" in
  working)
    binding=$(read_trusted_path "$trusted_root/local-binding-path" 'local binding path')
    route=(lint-local observe working "$candidate_root" "$revision" "$binding" "$evidence")
    ;;
  staged)
    binding=$(read_trusted_path "$trusted_root/local-binding-path" 'local binding path')
    route=(lint-local ratchet staged "$candidate_root" "$revision" "$binding" "$evidence")
    ;;
  committed)
    binding=$(read_trusted_path "$trusted_root/ci-binding-path" 'CI binding path')
    route=(lint-ci committed "$candidate_root" "$revision" "$evidence")
    ;;
  *)
    printf 'tool-wiki lint: selection must be working, staged or committed\n' >&2
    exit 64
    ;;
esac

snapshot_dir=$(mktemp -d)
snapshot_cli="$snapshot_dir/validator.mjs"
trap 'rm -rf -- "$snapshot_dir"' EXIT
env -i PATH="$trusted_path" "$bun_path" run --cwd "$(dirname -- "$snapshotter")" --no-env-file \
  "$snapshotter" "$binding" "$trusted_cli" "$candidate_root" "$snapshot_cli"

# Proof: gate-entrypoints.test.ts swaps the reviewed validator path to candidate code after the
# snapshot command returns; this immutable bundle retains the reviewed output and writes no marker.
if env -i PATH="$trusted_path" TOOL_WIKI_CI_TRUSTED_BINDING="$binding" \
  "$bun_path" run --cwd "$snapshot_dir" --no-env-file "$snapshot_cli" "${route[@]}"; then
  status=0
else
  status=$?
fi
rm -rf -- "$snapshot_dir"
trap - EXIT
exit "$status"
