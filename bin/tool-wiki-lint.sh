#!/usr/bin/env bash
set -euo pipefail

selection=${1:?candidate selection is required}
repository=${2:?candidate repository is required}
revision=${3:?candidate revision or base is required}
# Proof: defaulting this to the candidate CLI made the missing-authority test reach
# `/candidate/tools/tool-wiki/src/cli.ts` instead of naming TOOL_WIKI_TRUSTED_CLI.
trusted_cli=${TOOL_WIKI_TRUSTED_CLI:?TOOL_WIKI_TRUSTED_CLI must name the externally selected validator}
# Proof: defaulting evidence into the candidate made the missing-evidence adapter test exit 0
# with the candidate path, where the required external selection exits before validation.
evidence=${TOOL_WIKI_LINT_EVIDENCE:?TOOL_WIKI_LINT_EVIDENCE must name the candidate evidence}

case "$selection" in
  working)
    # Local trust is still external: the candidate being inspected cannot supply this path.
    binding=${TOOL_WIKI_LOCAL_TRUSTED_BINDING:?TOOL_WIKI_LOCAL_TRUSTED_BINDING must name external local trust}
    exec bun run "$trusted_cli" lint-local observe working "$repository" "$revision" "$binding" "$evidence"
    ;;
  staged)
    # Proof: defaulting this to candidate docs made the staged missing-authority test exit 0
    # through the supplied validator (`Expected: not 0`, received 0).
    binding=${TOOL_WIKI_LOCAL_TRUSTED_BINDING:?TOOL_WIKI_LOCAL_TRUSTED_BINDING must name external local trust}
    exec bun run "$trusted_cli" lint-local ratchet staged "$repository" "$revision" "$binding" "$evidence"
    ;;
  committed)
    # Proof: removing this preflight made the committed adapter exit 0 through a validator
    # that received no CI binding (`Expected: not 0`, received 0).
    : "${TOOL_WIKI_CI_TRUSTED_BINDING:?TOOL_WIKI_CI_TRUSTED_BINDING must be preselected outside the candidate}"
    exec bun run "$trusted_cli" lint-ci committed "$repository" "$revision" "$evidence"
    ;;
  *)
    printf 'tool-wiki lint: selection must be working, staged or committed\n' >&2
    exit 64
    ;;
esac
