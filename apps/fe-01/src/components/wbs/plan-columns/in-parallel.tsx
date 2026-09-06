import { CellInput } from '../cell-input';
import { cellKey } from '../editable-grid';
import { flushCell } from '../live-editing';
import type { PlanLive } from '../plan-live';
import { column } from './column';

/** Builds the in-parallel column family against the stable live cell contract. */
export function createInParallelColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'in-parallel',
    meta: { spokenHeading: 'People at once' },
    // A two-person mark, not `In parallel` and not `PAR`: the column is
    // 32px at a 10px all-caps header, in which even three letters wrap.
    // The `∥` it replaced read as "parallel" to a reader who had not
    // already been told — two people is the shortest thing that reads as
    // "at once" unprompted, and it is not a font glyph, so no platform
    // renders it as a box. The sentence is the accessible name
    // (`meta.spokenHeading`, announced by screen readers) and the
    // `title` — the bargain Prio, Days, Not bef., Start, End and Slack
    // already make. The `title` is on the `<th>` since `wbs-column-hints`,
    // where every column's is, and this one is the shape the rest were
    // written to.
    header: () => (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    cell: ({ row }) => {
      const own = row.original.maxParallel;
      const hasChildren = row.subRows.length > 0;
      /**
       * Who be-01's `widthFor` reads for one step of this leaf — its own
       * assignee, or the row's single assumed one. The same fallback
       * `assigneeOn` reads two columns back, because `widthFor` is built
       * from exactly this pair (`work-item.service.ts`'s `personFor`).
       */
      const personForStep = (stepId: string): string | null =>
        row.original.assignees[stepId] ?? row.original.doesEveryStep ?? null;
      const estimatedSteps = Object.keys(row.original.estimates);
      /**
       * Whether **every** slice `widthFor` would cut this leaf into is
       * pinned to width 1 by a named person — the only reading that
       * agrees with be-01, which collapses **per slice** and not per row.
       *
       * `doesEveryStep` alone used to stand in for this and is still the
       * right answer for a leaf with one step, or with several steps and
       * one assumed assignee — but it is `null` the moment a *second*
       * step gets its own explicit name, because `assumedAssignee`
       * requires exactly one named assignment project-wide on the row.
       * Two steps on two different people each still collapse their own
       * slice to width 1; the row-level reading just stopped being able
       * to say so.
       */
      const everySliceNamed =
        estimatedSteps.length > 0
          ? estimatedSteps.every((stepId) => personForStep(stepId) !== null)
          : row.original.doesEveryStep !== null;
      // Three states the cell renders differently, and each of them is a
      // fact the reader cannot get anywhere else:
      //
      // - a **parent** holds no slices of its own, so `slicesOf` skips it
      //   and a number on it schedules nothing. The write path answers 400
      //   `has_children`; the cell is read-only rather than offering an
      //   edit be-01 refuses. A leaf that later gained a child keeps
      //   whatever it was given, inert, and the cell says so.
      // - a leaf whose **every estimated step** is named runs each of
      //   those slices at width 1 whatever this says (D3): one human
      //   cannot work beside themselves. The number is still stored and
      //   still applies the moment a name comes off, so it is shown muted
      //   rather than hidden.
      // - anything else is an ordinary editable number.
      const inert = hasChildren || (everySliceNamed && own > 1);
      const why = hasChildren
        ? 'This row has children, so it holds no work of its own. The number is kept and does nothing.'
        : everySliceNamed && own > 1
          ? 'Everybody on this work is named, so it runs one at a time whatever this says.'
          : own > 1
            ? `${String(own)} people at once. The item's effort is compressed across them, up to the team's size.`
            : 'How many people may work on this item at once. Blank means one at a time.';
      // The first three branches say something about **this row** — it
      // holds no work, everybody on it is named, or its number is being
      // applied — and the last says what the column is for. Only the last
      // is a tool hint, and it is the only one reached with no children
      // and no second person, so the two faces of the cell agree by
      // construction rather than by two authors remembering to.
      const whyIsAboutThisRow = hasChildren || own > 1;
      if (hasChildren) {
        return (
          <span
            data-in-parallel={row.original.id}
            {...(whyIsAboutThisRow ? { 'data-fact': why } : { 'data-hint': why })}
            className="text-muted-foreground block text-right"
          >
            {own > 1 ? String(own) : ''}
          </span>
        );
      }
      return (
        <CellInput
          aria-label={`People at once for ${row.original.number}`}
          cellKey={cellKey(row.original.id, 'in-parallel')}
          data-in-parallel={row.original.id}
          inputMode="numeric"
          {...(whyIsAboutThisRow ? { 'data-fact': why } : { 'data-hint': why })}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            background: 'transparent',
            border: 'none',
            textAlign: 'right',
            // Muted where the number is stored and not applied, which is
            // the one thing a reader of a `3` beside a named person cannot
            // work out. `opacity` rather than a colour token so the value
            // stays the cell's own ink in either theme.
            opacity: inert ? 0.55 : undefined,
          }}
          onKeyDown={(e) => {
            // Enter saves, exactly as the Prio cell one column back does
            // and for its reason — see the comment there.
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
              e.preventDefault();
              void flushCell(e.currentTarget);
              return;
            }
            live.current.onAltMove(e, row.original, 'in-parallel');
            live.current.onCommandKey(e, row.original, 'in-parallel');
            live.current.onTabKey(e, row.original.id, 'in-parallel');
            live.current.onArrowKey(e, row.original.id, 'in-parallel');
          }}
          // Blank at 1, which is every row of every plan nobody has widened
          // — the Prio column's bargain, for the same reason: a column of
          // `1`s down a plan that runs one at a time is furniture.
          value={own > 1 ? String(own) : ''}
          commit={(typed) => live.current.setParallelism(row.original.id, typed)}
        />
      );
    },
  });
}
