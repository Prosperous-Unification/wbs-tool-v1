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

# Default project list: every directory holding a project.json, which is how the
# original sweep arrived at its 23 projects.
if [ "$#" -gt 0 ]; then
  projects=("$@")
else
  mapfile -t projects < <(cd "$root" && git ls-files -- '*/project.json' | xargs -r -n1 dirname | sort -u)
fi

for pj in "${projects[@]}"; do
  name=$(printf '%s' "$pj" | tr '/' '-')
  if ! cd "$root/$pj" 2>/dev/null; then
    echo "$pj MISSING" >> "$out/index.txt"
    continue
  fi
  start=$(date +%s)
  bun test --reporter=junit --reporter-outfile="$out/$name.xml" > "$out/$name.log" 2>&1
  rc=$?
  echo "$pj rc=$rc secs=$(( $(date +%s) - start ))" >> "$out/index.txt"
done

# JUnit XML -> ranked report. This is the step the archived copy was missing, so
# the harness now ends where the cited artifact begins.
cd "$root" && python3 - "$out" "$report" "${projects[@]}" <<'PY'
import os, sys, xml.etree.ElementTree as ET

out_dir, report_path = sys.argv[1], sys.argv[2]
projects = sys.argv[3:]
DEFAULT_BUDGET_MS = 5000

cases = []
for project in projects:
    xml_path = os.path.join(out_dir, project.replace('/', '-') + '.xml')
    if not os.path.exists(xml_path):
        continue
    for case in ET.parse(xml_path).getroot().iter('testcase'):
        ms = float(case.get('time') or 0) * 1000
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
    return DEFAULT_BUDGET_MS / ms if ms else 0.0

lines = ['cases measured: %d across %d projects' % (len(cases), len(worst)), '']
lines.append('TIGHTEST 15 CASES BY MARGIN TO %dms' % DEFAULT_BUDGET_MS)
for ms, project, name in cases[:15]:
    lines.append('%8dms %8.1fx  %s  %s' % (ms, margin(ms), project, name))
lines += ['', 'PER PROJECT WORST CASE']
for project, (ms, _) in sorted(worst.items(), key=lambda kv: -kv[1][0]):
    lines.append('%8dms %8.1fx %6d cases  %s' % (ms, margin(ms), counts[project], project))

with open(report_path, 'w') as handle:
    handle.write('\n'.join(line.rstrip() for line in lines) + '\n')
print('wrote', report_path, len(cases), 'cases')
PY

echo done > "$out/sweep.done"
