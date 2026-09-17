import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * What a fallback says when the thing thrown was not an `Error` at all.
 *
 * Reachable: `throw 'nope'` is legal JavaScript and a dependency can do it.
 * The sentence names the absence rather than printing `undefined` beside a
 * colon.
 */
const NO_MESSAGE = 'the reason it gave was not an error message';

/**
 * Whatever was thrown, as words to put inside a boundary's own sentence.
 *
 * Shared by both boundaries, which their two byte-identical copies were not
 * until 2026-09-02 — `app-fault.tsx` carried a note saying the two must stay
 * apart because "the two boundaries say different things about different
 * scopes". That is true of the **sentence** and this is not the sentence: "The
 * app stopped: …" and "The chart cannot be drawn: …" live in each boundary's
 * own JSX, and what is shared is the reading of a thrown value. A boundary that
 * ever needs a different phrase for an absent message can say so where it says
 * everything else.
 */
export function faultWords(thrown: unknown): string {
  if (!(thrown instanceof Error)) return NO_MESSAGE;
  return thrown.message === '' ? NO_MESSAGE : thrown.message;
}

export interface FaultBoundaryProps {
  /**
   * What a caught fault renders instead of the children, given the thrown
   * value's own words.
   *
   * The whole of what differs between the two boundaries, and the reason the
   * fallback is a prop rather than a `message` this class knows how to print:
   * one of them offers a reload of the document and the other says the plan
   * above it is unaffected, and neither sentence is true of the other's scope.
   */
  fallback: (message: string) => ReactNode;
  /**
   * What the console line calls the thing that could not render.
   *
   * Logged, and not a log-and-continue: the render is already refused and the
   * reader is already told. This is the trace of **where** it was thrown, which
   * is the one thing the sentence on screen leaves out.
   */
  logAs: string;
  /**
   * The identity of the state the children were drawn from; a fault clears when
   * it moves, and only then.
   *
   * React never retries a boundary on its own, so a boundary with nothing to
   * reset against latches until it is remounted. The Gantt panel passes the
   * **tree read's** generation, because the fault it catches is a payload skew
   * that is over by the next whole read; the root passes a constant, because
   * whatever state the tree held is gone with the tree and no later prop can
   * prove the fault is over.
   *
   * Cleared through here rather than by a `key` on the element: a `key` would
   * remount the children on every change and take the chart's scroll position
   * with it.
   */
  resetKey: number | string;
  children: ReactNode;
}

interface FaultBoundaryState {
  /** The caught error's own words, or null while nothing has been caught. */
  message: string | null;
  /** The {@link FaultBoundaryProps.resetKey} this state was decided against. */
  resetKey: number | string;
}

/**
 * The machinery both of this app's error boundaries are, with everything that
 * differs between them passed in.
 *
 * A class because React has no hook for this: `getDerivedStateFromError` is a
 * class-only lifecycle. It was written out twice — two constructors, two
 * `getDerivedStateFromError`, two `componentDidCatch`, two `render` guards —
 * and the second one grew the reset the first one still has no use for.
 *
 * Where each boundary stands and why is on {@link AppFaultBoundary} and
 * {@link GanttFaultBoundary}; that argument is about scope, not about this.
 */
export class FaultBoundary extends Component<FaultBoundaryProps, FaultBoundaryState> {
  constructor(props: FaultBoundaryProps) {
    super(props);
    this.state = { message: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(thrown: unknown): Pick<FaultBoundaryState, 'message'> {
    return { message: faultWords(thrown) };
  }

  /**
   * Clears a fault when the children's state has moved on, and only then.
   *
   * Runs before every render, including the one that follows
   * `getDerivedStateFromError` — where the key has not moved, so the fault
   * stands and the fallback is what renders.
   */
  static getDerivedStateFromProps(
    props: FaultBoundaryProps,
    state: FaultBoundaryState,
  ): FaultBoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { message: null, resetKey: props.resetKey };
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    console.error(this.props.logAs, thrown, info.componentStack);
  }

  override render(): ReactNode {
    const { message } = this.state;
    return message === null ? this.props.children : this.props.fallback(message);
  }
}
