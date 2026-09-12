#!/usr/bin/env bash
set -euo pipefail

selection=${1:?candidate selection is required}
repository=${2:?candidate repository is required}
revision=${3:?candidate revision or base is required}

activation_root=${TOOL_WIKI_ACTIVATION_ROOT:-}
required=${TOOL_WIKI_REQUIRE_CERTIFIED:-0}
if [[ "$required" != 0 && "$required" != 1 ]]; then
  printf 'tool-wiki lint: TOOL_WIKI_REQUIRE_CERTIFIED must be 0 or 1\n' >&2
  exit 64
fi
if [[ -z "$activation_root" ]] || [[ ! -e "$activation_root" ]]; then
  if [[ "$required" == 1 ]]; then
    # Proof: the workflow-equivalent test set required admission with no activation and observed
    # exit 0 plus an inactive report until this required boundary refused it.
    printf 'tool-wiki lint: required admission has no external activation root\n' >&2
    exit 78
  fi
  printf '%s\n' '{"schemaVersion":1,"status":"inactive","certified":false,"reason":"external activation root is not provisioned"}'
  exit 0
fi
if [[ ! -d "$activation_root" ]]; then
  printf 'tool-wiki lint: external activation root is not a directory\n' >&2
  exit 78
fi

candidate_root=$(cd -- "$repository" && pwd -P)
trusted_root=$(cd -- "$activation_root" && pwd -P)
bun_path=$(command -v bun)
trusted_path=$(dirname -- "$bun_path"):/usr/bin:/bin
case "$trusted_root/" in
  "$candidate_root/"*)
    printf 'tool-wiki lint: activation root must be outside the candidate repository\n' >&2
    exit 78
    ;;
esac

selection_descriptor="$trusted_root/selected.json"
if [[ -e "$selection_descriptor" ]]; then
  if ! selected=$(
    env -i PATH="$trusted_path" SELECTION_DESCRIPTOR="$selection_descriptor" "$bun_path" -e '
      const bytes = await Bun.file(Bun.env.SELECTION_DESCRIPTOR).text();
      const value = JSON.parse(bytes);
      const keys = Object.keys(value).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["checksumsIdentity", "directory", "identity", "schemaVersion"]) ||
          value.schemaVersion !== 1 || typeof value.directory !== "string" ||
          value.directory.length === 0 || value.directory.includes("\\") ||
          value.directory.split("/").some((part) => part === "" || part === "." || part === "..") ||
          typeof value.identity !== "string" || !/^[0-9a-f]{64}$/.test(value.identity) ||
          typeof value.checksumsIdentity !== "string" || !/^[0-9a-f]{64}$/.test(value.checksumsIdentity)) process.exit(1);
      process.stdout.write(`${value.directory}\n${value.identity}\n${value.checksumsIdentity}\n`);
    '
  ); then
    printf 'tool-wiki lint: activation selection is malformed\n' >&2
    exit 78
  fi
  selected_directory=${selected%%$'\n'*}
  selected_remainder=${selected#*$'\n'}
  selected_identity=${selected_remainder%%$'\n'*}
  selected_checksums_identity=${selected_remainder#*$'\n'}
  if ! selected_root=$(realpath -- "$trusted_root/$selected_directory") || [[ ! -d "$selected_root" ]]; then
    printf 'tool-wiki lint: selected activation directory is absent\n' >&2
    exit 78
  fi
  case "$selected_root/" in
    "$trusted_root/"*) ;;
    *) printf 'tool-wiki lint: selected activation escapes its external root\n' >&2; exit 78 ;;
  esac
  if [[ $(sha256sum -- "$selected_root/manifest.json" | cut -d ' ' -f 1) != "$selected_identity" ]] ||
    [[ $(sha256sum -- "$selected_root/checksums.sha256" | cut -d ' ' -f 1) != "$selected_checksums_identity" ]] ||
    ! (cd -- "$selected_root" && sha256sum --check --strict checksums.sha256 >/dev/null); then
    # Proof: required package selection accepted an empty/changed package until the launcher joined
    # the selected identity and complete artifact checksums before reading role descriptors.
    printf 'tool-wiki lint: selected activation package failed digest verification\n' >&2
    exit 78
  fi
  trusted_root=$selected_root
fi

marker="$trusted_root/active-v1"
if [[ ! -e "$marker" ]]; then
  if [[ "$required" == 1 ]]; then
    printf 'tool-wiki lint: required admission has no external activation marker\n' >&2
    exit 78
  fi
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
  if [[ "$selected" != /* ]]; then selected="$trusted_root/$selected"; fi
  if [[ ! -r "$selected" ]]; then
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
report_path="$snapshot_dir/report.json"
if env -i PATH="$trusted_path" TOOL_WIKI_CI_TRUSTED_BINDING="$binding" \
  "$bun_path" run --cwd "$snapshot_dir" --no-env-file "$snapshot_cli" "${route[@]}" >"$report_path"; then
  status=0
else
  status=$?
fi
cat -- "$report_path"
if [[ "$status" == 0 && "$required" == 1 ]]; then
  # Proof: the workflow-equivalent test returned exit 0 with output lacking a certified enforce
  # decision until required admission decoded and checked the trusted validator's actual report.
  if ! env -i PATH="$trusted_path" REPORT_PATH="$report_path" "$bun_path" -e '
    const report = JSON.parse(await Bun.file(Bun.env.REPORT_PATH).text());
    if (report?.schemaVersion !== 1 || report?.mode !== "enforce" ||
        report?.trustProvenance !== "ci-preselected" || report?.accepted !== true ||
        report?.certified !== true) process.exit(1);
  '; then
    printf 'tool-wiki lint: required admission did not return certified enforce output\n' >&2
    status=78
  fi
fi
rm -rf -- "$snapshot_dir"
trap - EXIT
exit "$status"
