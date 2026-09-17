import type { ReactNode } from 'react';

import { FaultBoundary } from '@/components/chrome/fault-boundary';

interface GanttFaultProps {
  /**
   * Which tree read the children are drawing.
   *
   * The reset key, and it must be the identity of the **read** rather than of
   * the panel: `layOutGantt` throws on a payload whose slices name something
   * the payload has not got, and the commonest way to get one is a peer's edit
   * landing between two of this client's reads. That skew is transient by
   * construction — the next whole read has neither half of it — so a boundary
   * that latched would turn a moment into a panel nobody can reopen without
   * reloading the page.
   */
  generation: number;
  children: ReactNode;
}

/**
 * The error boundary the Gantt panel's throws are thrown into, and nothing
 * else's.
 *
 * **It wraps the panel alone, deliberately.** The chart is the explicitly
 * optional feature AGENTS.md's degradation clause is about: the plan above it
 * is the editor, it is what the reader came for, and a chart that cannot be
 * drawn must cost them a chart rather than a page. A boundary any higher would
 * take the table down with the drawing.
 *
 * **The fallback says why.** {@link GanttDataError}'s messages are sentences
 * naming the slice and what it promised — `slice x is under step y, which this
 * plan does not list` — and they are the only description anybody has of a skew
 * that is over by the time it is read about. Printing "something went wrong"
 * over them would throw away the one artefact of the fault.
 *
 * **And it resets itself.** React never retries a boundary on its own: once
 * caught, the fallback stands until the boundary's state is cleared or it is
 * remounted. `generation` is the {@link FaultBoundary.resetKey}, and it moves on
 * every landed tree read, so the next refetch clears the fault and the panel
 * redraws.
 *
 * The machinery is {@link FaultBoundary}, shared with the root boundary since
 * 2026-09-02; what is here is this boundary's own scope and its own sentence.
 */
export function GanttFaultBoundary({ generation, children }: GanttFaultProps): ReactNode {
  return (
    <FaultBoundary
      logAs="the Gantt panel could not draw this plan"
      resetKey={generation}
      fallback={(message) => (
        <section data-gantt-fault aria-label="Gantt chart" className="border-border border-t p-3">
          <p role="status" className="text-sm">
            The chart cannot be drawn: {message}. The plan itself is unaffected, and the next read
            of it draws the chart again.
          </p>
        </section>
      )}
    >
      {children}
    </FaultBoundary>
  );
}
