#!/usr/bin/env bash
# Watched-red harness for `priority-bands`, run on h2puni.
#
# One fault at a time: apply, run only the file that is supposed to catch it,
# print what it printed, revert. Nothing is left behind — the `git diff --stat`
# at the end is the check on that, and it must be empty.
#
# NOT part of the change. Deleted before the branch is pushed for review.
set -uo pipefail
cd "$(dirname "$0")"
export PATH=/home/puni1/tools/node-v22.14.0-linux-x64/bin:/home/puni1/wbs-e2e-work/.bun-1314/bin:$PATH

be() { (cd apps/be-01 && bun test "$@" 2>&1 | tr -cd '\11\12\15\40-\176'); }
fe() { timeout 1800 node node_modules/vitest/vitest.mjs run --root apps/fe-01 --config apps/fe-01/vitest.config.ts "$@" --reporter=basic 2>&1 | tr -cd '\11\12\15\40-\176'; }

run() {
  local n="$1"; shift
  echo "=============== R5 #$n ==============="
  "$@"
  git checkout -- .
}

case "${1:-all}" in
1)
  # The seeding deleted from migration.sql.
  python3 - <<'PY'
p='apps/be-01/drizzle/20260814100000_add_priority_band/migration.sql'
s=open(p).read()
# From the statement breakpoint, so the CREATE TABLE above stays a whole,
# parseable statement and the only thing gone is the seeding.
s=s[:s.index("--> statement-breakpoint")]
open(p,'w').write(s)
PY
  be src/repository/migrate.test.ts | grep -E "^\(fail\)|toHaveLength|Expected|Received|received|[0-9]+ (pass|fail)" | head -20
  ;;
2)
  # ON DELETE CASCADE removed from the migration.
  sed -i 's| ON DELETE CASCADE||' apps/be-01/drizzle/20260814100000_add_priority_band/migration.sql
  be src/repository/migrate.test.ts | grep -E "^\(fail\)|FOREIGN KEY|error:|[0-9]+ (pass|fail)" | head -20
  ;;
3)
  # listFor's default arm deleted: an unconfigured project answers [].
  sed -i 's|    if (rows.length === 0) return DEFAULT_PRIORITY_BANDS.map((band) => ({ ...band }));||' apps/be-01/src/repository/priority-band.ts
  be src/repository/priority-band.test.ts | grep -E "^\(fail\)|Expected|Received|length|[0-9]+ (pass|fail)" | head -20
  ;;
4)
  # listFor's default arm made unconditional: every project answers the default.
  sed -i 's|    if (rows.length === 0) return DEFAULT_PRIORITY_BANDS.map((band) => ({ ...band }));|    return DEFAULT_PRIORITY_BANDS.map((band) => ({ ...band }));|' apps/be-01/src/repository/priority-band.ts
  be src/repository/priority-band.test.ts | grep -E "^\(fail\)|Expected|Received|[0-9]+ (pass|fail)" | head -20
  ;;
5)
  # The delete struck from replace(): an upsert-shaped write over live rows.
  sed -i 's|      tx.delete(projectPriorityBand).where(eq(projectPriorityBand.projectId, projectId)).run();||' apps/be-01/src/repository/priority-band.ts
  be src/repository/priority-band.test.ts | grep -E "^\(fail\)|UNIQUE|error:|[0-9]+ (pass|fail)" | head -20
  ;;
6)
  # The existence read deleted: the foreign key is the only guard left.
  python3 - <<'PY'
p='apps/be-01/src/repository/priority-band.ts'
s=open(p).read()
s=s.replace("""      const held = tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId))
        .all();
      if (held.length === 0) return { ok: false, reason: 'not_found' };
""","")
open(p,'w').write(s)
PY
  be src/repository/priority-band.test.ts | grep -E "^\(fail\)|FOREIGN KEY|error:|[0-9]+ (pass|fail)" | head -20
  ;;
7)
  # The one ladder guard deleted from the route.
  python3 - <<'PY'
p='apps/be-01/src/controller/priority-band.controller.ts'
s=open(p).read()
s=s.replace("""  const problem = priorityLadderProblem(bands);
  if (problem !== null) throw new BadLadder(problem);
""","")
open(p,'w').write(s)
PY
  be src/controller/priority-band.controller.test.ts | grep -E "^\(fail\)|Expected|Received|status|[0-9]+ (pass|fail)" | head -25
  ;;
8)
  # The typeof guard on a band's start struck.
  python3 - <<'PY'
p='apps/be-01/src/controller/priority-band.controller.ts'
s=open(p).read()
s=s.replace("""    if (typeof band['startsAt'] !== 'number') {
      throw new BadLadder('band_start_must_be_a_whole_number_from_1');
    }
""","")
s=s.replace("      startsAt: band['startsAt'],","      startsAt: band['startsAt'] as number,")
open(p,'w').write(s)
PY
  be src/controller/priority-band.controller.test.ts | grep -E "^\(fail\)|Expected|Received|[0-9]+ (pass|fail)" | head -25
  ;;
9)
  # The announcement deleted: a re-cut ladder reaches nobody else's screen.
  sed -i "s|    await this.opts.broadcast.publish(projectId, { type: 'priority_bands_changed' });||" apps/be-01/src/service/priority-band.service.ts
  be src/controller/priority-band.controller.test.ts | grep -E "^\(fail\)|Expected|Received|[0-9]+ (pass|fail)" | head -20
  ;;
10)
  # **The headline.** The ladder handed to the leveller: `goesFirst` ordering on
  # the band's rank instead of the priority — the scheduling change this whole
  # change claims not to be.
  python3 - <<'PY'
p='apps/be-01/src/service/work-item.service.ts'
s=open(p).read()
s=s.replace("""    const teamOf = effectiveTeamOf(rows);""","""    const teamOf = effectiveTeamOf(rows);
    // INJECTED FAULT: the ladder reaching the schedule.
    const banded = rows.map((row) => ({
      ...row,
      priority:
        row.priority === null
          ? null
          : (priorityBands.findLast((band) => band.startsAt <= (row.priority ?? 1))?.startsAt ?? 1),
    }));""")
s=s.replace("""    const slices = slicesOf(
      rows,""","""    const slices = slicesOf(
      banded,""")
s=s.replace("""      const planned = schedule(rows, edges, slices, notBefore, slotsOf);""","""      const planned = schedule(banded, edges, slices, notBefore, slotsOf);""")
open(p,'w').write(s)
PY
  be src/service/priority-band-identity.test.ts | grep -E "^\(fail\)|^[-+] |[0-9]+ (pass|fail)" | head -25
  ;;
11)
  # The band's ink taken off the Prio cell.
  sed -i 's|          color: paint?.ink,||' apps/fe-01/src/components/wbs/priority-cell.tsx
  fe src/components/wbs/wbs-table.test.tsx -t "draws the number in its band" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
12)
  # The cap taken off the bars.
  python3 - <<'PY'
p='apps/fe-01/src/components/wbs/gantt-panel.tsx'
s=open(p).read()
a=s.index("              {drawnBars.flatMap(({ bar, x, width }) => {")
b=s.index("              })}", a)+len("              })}")
s=s[:a]+s[b:]
open(p,'w').write(s)
PY
  fe src/components/wbs/gantt-panel.test.tsx -t "caps a bar" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
13)
  # The chip taken off the card header.
  python3 - <<'PY'
p='apps/fe-01/src/components/wbs/plan-cards.tsx'
s=open(p).read()
a=s.index("              {(() => {\n                const paint = priorityBandStyleOf(priorityBands, row.priority);")
b=s.index("              })()}", a)+len("              })()}")
s=s[:a]+s[b:]
open(p,'w').write(s)
PY
  fe src/components/wbs/plan-cards.test.tsx -t "names the band on a card" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
14)
  # The export column reading the default ladder instead of the plan's.
  sed -i 's|priorityBandOf(plan.priorityBands, row.priority)|priorityBandOf(DEFAULT_PRIORITY_BANDS, row.priority)|' apps/fe-01/src/components/wbs/plan-export.ts
  sed -i "s|import { priorityBandOf } from '@wbs/domain/priority-band';|import { DEFAULT_PRIORITY_BANDS, priorityBandOf } from '@wbs/domain/priority-band';|" apps/fe-01/src/components/wbs/plan-export.ts
  fe src/components/wbs/plan-export.test.ts -t "names the band beside the number" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
15)
  # The dialog's empty-box arm replaced by a bare Number().
  python3 - <<'PY'
p='apps/fe-01/src/components/wbs/priorities-dialog.tsx'
s=open(p).read()
s=s.replace("""    if (draft.startsAt.trim() === '' || !Number.isSafeInteger(startsAt)) return null;
    if (draft.defaultValue.trim() === '' || !Number.isSafeInteger(defaultValue)) return null;""","")
open(p,'w').write(s)
PY
  fe src/components/wbs/priorities-dialog.test.tsx -t "refuses an empty box" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
16)
  # Save narrowed to the rung that changed.
  python3 - <<'PY'
p='apps/fe-01/src/components/wbs/priorities-dialog.tsx'
s=open(p).read()
s=s.replace("      await setBands(ladder);","      await setBands(ladder.slice(0, 1));")
open(p,'w').write(s)
PY
  fe src/components/wbs/priorities-dialog.test.tsx -t "sends the whole ladder" | grep -E "FAIL|AssertionError|→|Tests " | head -10
  ;;
17)
  # The band list opened on the focus instead of on a click.
  python3 - <<'PY'
p='apps/fe-01/src/components/wbs/priority-cell.tsx'
s=open(p).read()
s=s.replace("""        onClick={() => {
          setOpen(true);
        }}""","")
s=s.replace("""      onBlur={() => {
        setOpen(false);
      }}""","""      onFocus={() => {
        setOpen(true);
      }}
      onBlur={() => {
        setOpen(false);
      }}""")
open(p,'w').write(s)
PY
  fe src/components/wbs/wbs-table.test.tsx -t "the priority cell" | grep -E "FAIL|AssertionError|→|Tests " | head -20
  ;;
esac
git checkout -- .
echo "--- tree after revert ---"
git diff --stat | tail -3
