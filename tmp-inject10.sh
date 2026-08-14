#!/usr/bin/env bash
# R5 #10 on its own: the ladder reaching the leveller.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/home/puni1/tools/node-v22.14.0-linux-x64/bin:/home/puni1/wbs-e2e-work/.bun-1314/bin:$PATH

python3 - <<'PY'
p = 'apps/be-01/src/service/work-item.service.ts'
s = open(p).read()
a = s.replace(
    "    const teamOf = effectiveTeamOf(rows);",
    """    const teamOf = effectiveTeamOf(rows);
    const banded = rows.map((row) => ({
      ...row,
      priority:
        row.priority === null
          ? null
          : priorityBands.length -
            priorityBands.reduce(
              (rank, band, at) => (band.startsAt <= (row.priority ?? 1) ? at : rank),
              0,
            ),
    }));""",
)
assert a != s, 'banded not inserted'
s = a
a = s.replace("    const slices = slicesOf(\n      rows,", "    const slices = slicesOf(\n      banded,")
assert a != s, 'slicesOf not repointed'
s = a
a = s.replace(
    "schedule(rows, edges, slices, notBefore, slotsOf)",
    "schedule(banded, edges, slices, notBefore, slotsOf)",
)
assert a != s, 'schedule not repointed'
open(p, 'w').write(s)
print('injected')
PY

set +e
(cd apps/be-01 && bun test src/service/priority-band-identity.test.ts 2>&1 | tr -cd '\11\12\15\40-\176') \
  | grep -E "^\(fail\)|^[-+] |[0-9]+ (pass|fail)|toEqual|Expected|Received" | head -25
set -e
git checkout -- .
echo "--- tree after revert ---"
git diff --stat | tail -2
