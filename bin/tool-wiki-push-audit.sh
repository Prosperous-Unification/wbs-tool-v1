#!/usr/bin/env bash
set -euo pipefail

candidate_root=${1:?candidate checkout is required}
revision=${2:?committed revision is required}
activation_root=${TOOL_WIKI_ACTIVATION_ROOT:-}

# Proof: gate-entrypoints.test.ts runs this production script without an external activation root
# and observes an explicit non-certifying inactive report with exit 0.
if [[ -z $activation_root ]]; then
  printf '%s\n' '{"schemaVersion":1,"status":"inactive","certified":false,"reason":"external activation marker is not provisioned"}'
  exit 0
fi
# Proof: gate-entrypoints.test.ts configures an otherwise empty activation root and observes exit
# 78, so lost provisioning cannot collapse back into intentional inactivity.
if [[ ! -e "$activation_root/active-v1" ]]; then
  printf 'configured activation root has no marker\n' >&2
  exit 78
fi

if ! trusted_root=$(realpath -- "$activation_root") || [[ ! -d $trusted_root ]]; then
  printf 'external activation root is not a readable directory\n' >&2
  exit 78
fi
if ! candidate=$(realpath -- "$candidate_root") || [[ ! -d $candidate ]]; then
  printf 'candidate checkout is not a readable directory\n' >&2
  exit 78
fi
# Proof: gate-entrypoints.test.ts places the activation root inside the candidate while its
# launcher points outward and observes exit 78 before launcher selection.
case "$trusted_root" in
  "$candidate" | "$candidate"/*)
    printf 'external activation root resolved inside candidate checkout\n' >&2
    exit 78
    ;;
esac

marker="$trusted_root/active-v1"
if [[ ! -f $marker ]] || [[ ! -r $marker ]] || [[ $(<"$marker") != tool-wiki-active-v1 ]]; then
  printf 'external activation marker is unreadable or malformed\n' >&2
  exit 78
fi
descriptor="$trusted_root/launcher-path"
if [[ ! -r $descriptor ]]; then
  printf 'external activation has no readable launcher descriptor\n' >&2
  exit 78
fi
launcher_ref=$(<"$descriptor")
if ! launcher=$(realpath -- "$trusted_root/$launcher_ref") || [[ ! -f $launcher ]] ||
  [[ ! -r $launcher ]]; then
  printf 'external launcher is not a readable regular file\n' >&2
  exit 78
fi
# Proof: gate-entrypoints.test.ts invokes this production script through a symlinked candidate
# workspace while the external descriptor resolves back into it; canonical comparison exits 78.
# This stays ahead of the root rule below so a candidate-owned launcher keeps its own name.
case "$launcher" in
  "$candidate"/*)
    printf 'external launcher resolved inside candidate checkout\n' >&2
    exit 78
    ;;
esac
# Proof: gate-entrypoints.test.ts sets the descriptor to `../outside-launcher.sh` and observed that
# launcher run with exit 0; the old rule refused only a launcher inside the candidate, while the
# archive's transport digest authenticates nothing outside the archive at all.
case "$launcher" in
  "$trusted_root"/*) ;;
  *)
    printf 'external launcher resolved outside its activation root\n' >&2
    exit 78
    ;;
esac

modules_input=${TOOL_WIKI_TRUSTED_NODE_MODULES:-$trusted_root/trusted-node-modules}
# Proof: gate-entrypoints.test.ts removes the archive runtime closure and observes exit 78 before
# the external launcher can run.
if ! trusted_modules=$(realpath -- "$modules_input") || [[ ! -d $trusted_modules ]] ||
  [[ ! -f $trusted_modules/typescript/package.json ]]; then
  printf 'trusted TypeScript runtime modules are not provisioned: %s\n' "$modules_input" >&2
  exit 78
fi
# Proof: gate-entrypoints.test.ts explicitly points the runtime override inside the candidate and
# observes exit 78 before the launcher can inherit it.
case "$trusted_modules" in
  "$candidate" | "$candidate"/*)
    printf 'trusted TypeScript runtime modules resolved inside candidate checkout\n' >&2
    exit 78
    ;;
esac
export TOOL_WIKI_TRUSTED_NODE_MODULES="$trusted_modules"
export TOOL_WIKI_REQUIRE_CERTIFIED=1

# Proof: gate-entrypoints.test.ts supplies a relative descriptor and observes the external
# launcher receive the canonical candidate path, exact revision, archive runtime, and required
# certification flag, independent of caller cwd.
exec bash "$launcher" committed "$candidate" "$revision"
