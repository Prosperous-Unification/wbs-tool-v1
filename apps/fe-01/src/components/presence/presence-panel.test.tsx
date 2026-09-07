import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PresencePanel } from './presence-panel';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * The gateway socket, standing still.
 *
 * jsdom's own `WebSocket` would try to open a real connection to a gateway that
 * is not running, which makes the roster arrive never and the test wait for it.
 * This one records what it was told and hands the component's own handlers back
 * to the test, so a frame arrives when the test says so.
 */
class StillSocket {
  static opened: StillSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    StillSocket.opened.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closed = true;
  }
}

/** The one this render opened, or a failure that says none was. */
function socket(): StillSocket {
  const only = StillSocket.opened.at(-1);
  if (only === undefined) throw new Error('the panel opened no socket at all');
  return only;
}

const realWebSocket = globalThis.WebSocket;

/**
 * What the panel's aria contract is, which nothing asserted before this change.
 *
 * The panel moved into the header bar in `H header-fits-a-row` and its markup
 * was rewritten around that — a grey label and one clipped line rather than a
 * section with a bulleted list. Every role and name it had is the same, and
 * this file is what makes that a fact rather than a claim: it was written
 * because the move found no assertion to keep, which is `F shadcn-foundation`'s
 * rule after the auth panel silently stopped being a heading.
 *
 * Watched failures are quoted in
 * `openspec/changes/header-fits-a-row/verify.md`.
 */
describe('the presence panel', () => {
  beforeEach(() => {
    StillSocket.opened.length = 0;
    // The boundary that makes the cast safe: this is a test double for one
    // global, restored below, and the component uses four members of it.
    globalThis.WebSocket = StillSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = realWebSocket;
  });

  const mount = (projectId: string | null = 'p-hull') =>
    render(<PresencePanel me="kat" projectId={projectId} />);

  /** What this socket was told, as parsed frames. */
  const framesSentBy = (s: StillSocket) => s.sent.map((f) => JSON.parse(f) as { type?: string });

  /** Opens the socket and delivers one roster frame, the way gw-01 does. */
  function arrive(users: string[]): void {
    act(() => {
      socket().onopen?.();
    });
    act(() => {
      socket().onmessage?.(
        new MessageEvent('message', { data: JSON.stringify({ type: 'presence', users }) }),
      );
    });
  }

  itDom('names itself with a heading that carries the connection', () => {
    mount();

    expect(screen.getByRole('heading', { name: 'Online (connecting)' })).toBeDefined();
    act(() => {
      socket().onopen?.();
    });
    expect(screen.getByRole('heading', { name: 'Online (open)' })).toBeDefined();
  });

  itDom('names its project, then asks who is there, as soon as the socket opens', () => {
    // F4: gw-01's roster used to be every username connected to the gateway,
    // because nothing on this socket ever said which project it was for. The
    // subscribe is that statement, and it goes first — `who` is answered with
    // this connection's own project, so the other order is answered with
    // nobody.
    //
    // Proof: the `subscribe` send deleted from `presence-panel.tsx`. This test
    // failed on `expect(framesSentBy(socket())).toEqual([...])` with only the
    // `who` frame sent — the same socket the gateway would have put in no
    // project at all.
    mount('p-hull');
    act(() => {
      socket().onopen?.();
    });

    expect(framesSentBy(socket())).toEqual([
      { type: 'subscribe', subscription: 'project:p-hull' },
      { type: 'who' },
    ]);
  });

  itDom('names no project when none is open, and asks anyway', () => {
    // A browser with nothing selected is in no roster — `who` is answered with
    // an empty list, which is the honest answer rather than the gateway's.
    mount(null);
    act(() => {
      socket().onopen?.();
    });

    expect(framesSentBy(socket())).toEqual([{ type: 'who' }]);
  });

  itDom('opens another socket for another project, and empties the roster first', () => {
    // Proof: `projectId` removed from the effect's dependency list. This test
    // failed on `expect(StillSocket.opened).toHaveLength(2)` receiving 1 — one
    // socket, still subscribed to `project:p-hull`, showing the old project's
    // people under the new project's name.
    const view = render(<PresencePanel me="kat" projectId="p-hull" />);
    arrive(['kat', 'sam']);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    view.rerender(<PresencePanel me="kat" projectId="p-keel" />);

    expect(StillSocket.opened).toHaveLength(2);
    expect(StillSocket.opened[0]?.closed).toBe(true);
    expect(screen.getByText('Nobody yet.')).toBeDefined();
    act(() => {
      socket().onopen?.();
    });
    expect(framesSentBy(socket())).toEqual([
      { type: 'subscribe', subscription: 'project:p-keel' },
      { type: 'who' },
    ]);
  });

  itDom('says so while nobody has arrived', () => {
    mount();

    expect(screen.getByText('Nobody yet.')).toBeDefined();
  });

  itDom('lists who is online, and marks which one is you', () => {
    mount();
    arrive(['kat', 'sam']);

    const roster = screen.getByRole('list');
    expect([...roster.querySelectorAll('li')].map((entry) => entry.textContent)).toEqual([
      'kat (you)',
      'sam',
    ]);
  });

  itDom('says the connection has closed, and starts no other', () => {
    mount();
    arrive(['kat', 'sam']);
    act(() => {
      socket().onclose?.();
    });

    // The caveat, pinned rather than fixed: one socket ever, and the roster
    // stays as it was. `H` moved this panel and deliberately did not give it a
    // reconnect — see the note on {@link PresencePanel}.
    expect(screen.getByRole('heading', { name: 'Online (closed)' })).toBeDefined();
    expect(StillSocket.opened).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
