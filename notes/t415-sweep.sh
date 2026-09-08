#!/usr/bin/env bash
# Per-case duration sweep: one full bun-test pass per project, ranked by margin
# to the 5000ms default case budget. Regenerates notes/t415-per-case-duration-sweep.txt.
#
# Archived from the TASK-415 run and made re-derivable by TASK-423, after a peer
# review pointed out that the original could not reproduce the artifact it was
# cited as evidence for: it hard-coded a checkout under $HOME, took its project
# list from argv with no default, and stopped at raw JUnit XML with no step that
# produced the ranked report. All three are fixed here.
#
# Usage:
#   notes/t415-sweep.sh                 # every bun-test project in this checkout
#   notes/t415-sweep.sh apps/be-01 ...  # only the named projects
#
# Runs from its own checkout — never from a copy under $HOME — so the numbers
# describe the tree you are reading. Per WORKER.md this belongs on h2puni, under
# the heavy lock, never on a workstation:
#   ssh h2puni 'cd ~/wbs-t423 && HEAVY_LOCK_WAIT_SECONDS=900 ./bin/with-heavy-lock.sh -- notes/t415-sweep.sh'
#
# Durations are one observation each, at whatever load the host had. They are not
# floors, and two sweeps of the same tree will disagree — the report says so in
# its own header, and the test comments that cite it record both observations.
set -u

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${SWEEP_OUT:-/dev/shm/t415}
report=${SWEEP_REPORT:-$root/notes/t415-per-case-duration-sweep.txt}
mkdir -p "$out"
: > "$out/index.txt"

# Default project list. Two filters, and both are load-bearing — checked against
# the committed artifact's 23 projects on 2026-09-08:
#   - every project.json, unfiltered, gives 26. The three extra are libs/solver-py
#     (unittest, which has no per-case budget, so a per-case margin report has
#     nothing to say about it), apps/fe-01, and a nested manifest.
#   - a declared bun-test target alone gives 24, dropping the first two.
#   - dropping projects nested inside another selected project removes
#     libs/contracts/solver/supervisor-protocol, whose cases the parent's own
#     sweep already counts, and lands on exactly 23.
if [ "$#" -gt 0 ]; then
  projects=("$@")
else
  mapfile -t projects < <(
    cd "$root" &&
      git ls-files -- '*/project.json' |
      xargs -r grep -lE '"bun[[:space:]]+test' |
      xargs -r -n1 dirname |
      sort -u |
      awk '{ for (i = 1; i <= n; i++) if (index($0 "/", kept[i] "/") == 1) next; kept[++n] = $0; print }'
  )
fi

# A report is evidence only if every number in it came from this sweep. The
# output directory is reused across sweeps, so each project's XML is removed
# before its pass: without that, a project that dies before writing replaces
# nothing, and yesterday's numbers are published under today's date next to
# freshly measured ones, with a successful exit. Peer review, 2026-09-08.
#
# The completion marker goes first, before any measuring: cleared after the loop
# it survives an interrupt, so a sweep killed part-way through leaves the
# previous sweep's marker sitting next to half-replaced XML, claiming a
# completion that did not happen. Peer review of 5d7b901a.
rm -f "$out/sweep.done"
failed=()
for pj in "${projects[@]}"; do
  name=$(printf '%s' "$pj" | tr '/' '-')
  rm -f "$out/$name.xml"
  if ! cd "$root/$pj" 2>/dev/null; then
    echo "$pj MISSING" >> "$out/index.txt"
    failed+=("$pj (no such project)")
    continue
  fi
  start=$(date +%s)
  bun test --reporter=junit --reporter-outfile="$out/$name.xml" > "$out/$name.log" 2>&1
  rc=$?
  echo "$pj rc=$rc secs=$(( $(date +%s) - start ))" >> "$out/index.txt"
  # A red suite still times its cases, so a nonzero exit is not on its own a
  # reason to discard the numbers -- but a project that produced no XML at all
  # measured nothing, and a report that silently omits it understates coverage.
  [ -s "$out/$name.xml" ] || failed+=("$pj (rc=$rc, no XML; see $out/$name.log)")
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'sweep incomplete, report NOT written:\n' >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi

# JUnit XML -> ranked report. This is the step the archived copy was missing, so
# the harness now ends where the cited artifact begins.
cd "$root" && python3 - "$out" "$report" "${projects[@]}" <<'PY'
import os, sys, xml.etree.ElementTree as ET

out_dir, report_path = sys.argv[1], sys.argv[2]
projects = sys.argv[3:]
DEFAULT_BUDGET_MS = 5000

cases = []
skipped = 0
for project in projects:
    xml_path = os.path.join(out_dir, project.replace('/', '-') + '.xml')
    for case in ET.parse(xml_path).getroot().iter('testcase'):
        # A skipped case has no duration to be tight against, and counting it as
        # "measured" both inflates the totals and lets a 0ms entry sort to the
        # top of a report whose whole subject is the tightest margins. Peer
        # review, 2026-09-08. A case with no `time` attribute at all is the same
        # situation -- unmeasured, not instantaneous.
        if case.find('skipped') is not None or case.get('time') is None:
            skipped += 1
            continue
        ms = float(case.get('time')) * 1000
        name = ' > '.join(p for p in (case.get('classname', ''), case.get('name', '')) if p)
        cases.append((ms, project, name))

cases.sort(reverse=True)
worst = {}
for ms, project, name in cases:
    worst.setdefault(project, (ms, name))
counts = {}
for _, project, _ in cases:
    counts[project] = counts.get(project, 0) + 1

def margin(ms):
    # A case that took no measurable time has unbounded margin, not none.
    return DEFAULT_BUDGET_MS / ms if ms else float('inf')

def margin_text(ms):
    return '     inf' if ms == 0 else '%8.1f' % margin(ms)

header = 'cases measured: %d across %d projects' % (len(cases), len(worst))
if skipped:
    header += ' (%d skipped or untimed, excluded)' % skipped
lines = [header, '']
lines.append('TIGHTEST 15 CASES BY MARGIN TO %dms' % DEFAULT_BUDGET_MS)
for ms, project, name in cases[:15]:
    lines.append('%8dms %sx  %s  %s' % (ms, margin_text(ms), project, name))
lines += ['', 'PER PROJECT WORST CASE']
for project, (ms, _) in sorted(worst.items(), key=lambda kv: -kv[1][0]):
    lines.append('%8dms %sx %6d cases  %s' % (ms, margin_text(ms), counts[project], project))
lines += ['',
          'under 3x margin: %d' % sum(1 for ms, _, _ in cases if margin(ms) < 3),
          'under 10x margin: %d' % sum(1 for ms, _, _ in cases if margin(ms) < 10)]

with open(report_path, 'w') as handle:
    handle.write('\n'.join(line.rstrip() for line in lines) + '\n')
print('wrote', report_path, len(cases), 'cases')
PY

echo done > "$out/sweep.done"
