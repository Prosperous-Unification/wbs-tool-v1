import { useEffect, useState } from 'react';

import { remembered } from '@/lib/remembered';

/**
 * The chart's **detail** switch, whole: the key it remembers, the reading of
 * that key, the state the panel holds, and the write a click makes.
 *
 * These four were 3,500 lines apart in `gantt-panel.tsx` — the constant and the
 * storage at the top, the state at the middle, the mark gates and the control
 * near the bottom — which is what W4-6 is about. What stays in the panel is
 * what the panel **draws**: the three `detailShown &&` gates over the marks,
 * and the switch's own label and classes.
 *
 * One answer for **two** families of mark — the stored-dependency arrows and
 * the parent rows' summary brackets — and not two switches: Dany asked for "all
 * decluttering into one button" (2026-08-12), so there is no per-family state to
 * disagree with itself.
 *
 * It was three until 2026-09-11. The unestimated slices' assumed bars were the
 * third, and they left the switch's scope when Dany saw a chart with the detail
 * off: _"with details disabled you still have to show the unestimated slices"_.
 * `gantt-panel.tsx`'s `drawnBars` carries the measurement.
 */

/**
 * Where this browser remembers whether it has asked for the chart's detail.
 *
 * One key for the browser, and that is where this parts from
 * `wbs.ganttHeight.<projectId>` beside it: a panel height is one plan's share of
 * one screen, while detail on or off is an answer about a **feature** — a reader
 * who has turned sixty elbows off has turned them off, and having to say so
 * again in the next project is the fault this remembers away.
 *
 * `wbs.ganttDetail` and no longer `wbs.ganttArrows`, because the switch no
 * longer answers about the arrows alone. See {@link RETIRED_ARROWS_KEY}.
 */
const DETAIL_KEY = 'wbs.ganttDetail';

/** The detail switch as stored — a boolean and nothing else; see {@link remembered}. */
const storedDetail = remembered(
  DETAIL_KEY,
  (claimed): claimed is boolean => typeof claimed === 'boolean',
);

/**
 * The key the arrows-only switch wrote, for one day, between `gantt-declutter`
 * and `declutter-one-button`.
 *
 * **Dropped rather than migrated**, and the difference matters: it held an
 * answer about the arrows, and this switch draws two further families of mark
 * with them. Reading a stored `true` across would open the chart with parent
 * brackets and uncosted bars on it for a reader who asked for elbows — which is
 * the clutter Dany asked to be rid of in the first place. So the answer is
 * discarded and the key is **removed**, rather than left in storage to be
 * puzzled over by whoever reads a browser's `localStorage` next.
 */
const RETIRED_ARROWS_KEY = 'wbs.ganttArrows';

/**
 * Drops the two keys this panel refuses, then reads the remembered answer.
 *
 * The chart's own starting answer is {@link readDetail}'s, not this function's
 * return — `true` for a plan with dependency edges, `false` without, and a
 * stored answer wherever this browser has said. This function exists for the
 * mount-effect **write** half of the read: the drop is a side effect and the
 * return is ignored by its one caller.
 *
 * The stored value is a claim, not a fact: user-editable storage read at a
 * boundary. Anything that is not a boolean takes the key with it and the switch
 * stays off. `JSON.parse` and a type check rather than `stored === 'true'`,
 * because the two answers a browser can hold have to be told apart from the
 * strings that merely look like them — `"yes"` parses fine and is not an answer.
 *
 * Deliberately not the "unknown is not OK" throw, for `rememberedGanttHeight`'s
 * reason: the alternative is a chart nobody can open until they clear storage by
 * hand, over a preference about a mark.
 */
function rememberedDetail(): boolean {
  // The retired key goes whatever this browser has said since, and its value is
  // never looked at: see {@link RETIRED_ARROWS_KEY}. `removeItem` on a key that
  // is not there is a no-op, so there is nothing to ask first.
  //
  // Proof: this line deleted. `drops the key the arrows switch wrote, without
  // reading it` alone failed, `1 failed | 90 passed`, on `expected 'true' to be
  // null` — the retired key still in storage after the chart had been opened.
  // Watched 2026-08-12.
  localStorage.removeItem(RETIRED_ARROWS_KEY);
  // Proof: this refusal replaced by `claimed === true || (typeof claimed ===
  // 'string' && claimed !== '')`, which is what "read the claim, drop nothing"
  // comes to. `2 failed | 89 passed`: `refuses a stored answer that is not a
  // boolean, and drops the key` on `expected 'true' to be 'false'` — the detail
  // drawn from the string `"yes"` — and `refuses storage that is not JSON at
  // all, and drops the key` on `expected '{not json' to be null`, the unreadable
  // key left in storage to be read again next time. Watched 2026-08-11, and
  // again over the renamed key 2026-08-12.
  //
  // The answer is thrown away and the **drop** is the point: `readAndDrop`
  // removes a key whose contents this panel refuses, and `readDetail` below
  // then reads the same three states without writing.
  storedDetail.readAndDrop();
  return readDetail();
}

/**
 * The same read with **nothing written** — what a React render is allowed to
 * do.
 *
 * `useState(() => readDetail(hasDependencyEdges))` below is a lazy initialiser,
 * which React calls during
 * a render and StrictMode calls **twice** on purpose to surface exactly this:
 * {@link rememberedDetail} drops two keys, and dropping a key is a write. The
 * rule is the one this file already states over the switch's own handler — "a
 * state updater React may call twice is no place for a side effect" — and it
 * was being kept eleven hundred lines below where it was being broken. The
 * drops happen in a mount effect instead.
 *
 * Nothing anybody can observe changed: `removeItem` is idempotent, and the
 * `DETAIL_KEY` drop only ever fires on a stored value this panel refuses. It is
 * a rule kept, not a defect fixed. Cross-review, 2026-08-12.
 */
function readDetail(hasEdges = false): boolean {
  const claimed = storedDetail.claim();
  if (claimed.status === 'held') return claimed.value;
  // Nothing stored: the chart opens with the detail on for a plan that has
  // dependency edges — a first-time reader sees the arrows without hunting for
  // the toggle — and off for a plan with nothing to hide. A **refused** answer
  // is not the same state and does not read as one: somebody has said
  // something here, and it is not "show me the arrows". That is the third
  // state {@link Claim} exists for.
  //
  // Proof: the two collapsed into `return hasEdges`, watched failing on
  // `expected 'true' to be 'false'` in `refuses a stored answer that is not a
  // boolean, and drops the key` and in `refuses storage that is not JSON at
  // all, and drops the key` — `2 failed | 159 passed`. Observed 2026-09-02.
  return claimed.status === 'absent' ? hasEdges : false;
}

/**
 * The detail switch as a panel holds it: what to draw, and how to ask.
 *
 * The read is the **initial state** rather than an effect, exactly as the panel
 * height is: an effect would draw every mark for one frame and then take them
 * away. The drops are a mount effect, because dropping a key is a write and a
 * lazy initialiser is a render React may call twice — StrictMode
 * double-invokes it on purpose to surface exactly that.
 *
 * `hasDependencyEdges` decides only the **never-said** case: a plan carrying
 * edges opens with the detail on, so a first-time reader sees the arrows a WBS
 * Gantt exists to show rather than a toggle they have to find (TASK-38). A
 * stored answer always wins — turning the detail off is a remembered choice.
 */
export interface GanttDetail {
  /** Whether the three families of mark are drawn. */
  shown: boolean;
  /** Asks for the next answer, and remembers it. */
  ask: (next: boolean) => void;
}

export function useGanttDetail(hasDependencyEdges: boolean): GanttDetail {
  const [shown, setShown] = useState(() => readDetail(hasDependencyEdges));
  // The retired key, and any stored answer this panel refuses, dropped once
  // after the first paint. The write half of the read above.
  useEffect(() => {
    rememberedDetail();
  }, []);
  return {
    shown,
    ask: (next) => {
      // Written here and nowhere else, so opening a chart never changes what is
      // remembered about it — the same bargain `rememberGanttHeight` makes with
      // a drag that is let go of.
      //
      // Proof: this line deleted, so the answer lived in the hook alone. `opens
      // with the detail a fresh panel is remounted onto` alone failed, `1 failed
      // | 90 passed`, on `expected 'false' to be 'true'` — the switch back off
      // on the next mount. Watched 2026-08-11 over the arrows key, and again
      // 2026-08-12 over this one.
      storedDetail.write(next);
      setShown(next);
    },
  };
}
