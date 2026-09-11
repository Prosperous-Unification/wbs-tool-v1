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
trusted_cli=$(cd -- "$(dirname -- "$trusted_cli")" && printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$trusted_cli")")
case "$trusted_cli" in
  "$candidate_root"/*)
    printf 'tool-wiki lint: validator must be outside the candidate repository\n' >&2
    exit 78
    ;;
esac
evidence=$(read_trusted_path "$trusted_root/evidence-path" 'evidence path')
bun_path=$(command -v bun)
trusted_path=$(dirname -- "$bun_path"):/usr/bin:/bin
validator_dir=$(dirname -- "$trusted_cli")

case "$selection" in
  working)
    binding=$(read_trusted_path "$trusted_root/local-binding-path" 'local binding path')
    exec env -i PATH="$trusted_path" "$bun_path" run --cwd "$validator_dir" --no-env-file \
      "$trusted_cli" lint-local observe working "$candidate_root" "$revision" "$binding" "$evidence"
    ;;
  staged)
    binding=$(read_trusted_path "$trusted_root/local-binding-path" 'local binding path')
    exec env -i PATH="$trusted_path" "$bun_path" run --cwd "$validator_dir" --no-env-file \
      "$trusted_cli" lint-local ratchet staged "$candidate_root" "$revision" "$binding" "$evidence"
    ;;
  committed)
    binding=$(read_trusted_path "$trusted_root/ci-binding-path" 'CI binding path')
    # Proof: gate-entrypoints.test.ts removes the externally selected CI binding and
    # observes this production adapter fail before the validator can inspect a candidate.
    exec env -i PATH="$trusted_path" TOOL_WIKI_CI_TRUSTED_BINDING="$binding" \
      "$bun_path" run --cwd "$validator_dir" --no-env-file "$trusted_cli" \
      lint-ci committed "$candidate_root" "$revision" "$evidence"
    ;;
  *)
    printf 'tool-wiki lint: selection must be working, staged or committed\n' >&2
    exit 64
    ;;
esac
