import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PresencePanel } from './presence-panel';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * What the panel's aria contract is, which nothing asserted before
 * `H header-fits-a-row`.
 *
 * The panel moved into the header bar in that change and its markup was
 * rewritten around it — a grey label and one clipped line rather than a section
 * with a bulleted list. Every role and name it had is the same, and this file is
 * what makes that a fact rather than a claim. Watched failures are quoted in
 * `openspec/changes/header-fits-a-row/verify.md`.
 *
 * **It opens no socket, since 2026-09-02.** The four cases that were about
 * frames — the `subscribe` before the `who`, the socket per project, the closed
 * connection that started no other — moved to `lib/project-stream.test.ts`,
 * which is where the socket is now: the roster rides the plan's own stream, so
 * a browser holds one connection rather than two. `StillSocket`, the
 * `globalThis.WebSocket` swap and the `act` wrappers went with them, and what is
 * left is a component that renders its props.
 */
describe('the presence panel', () => {
  afterEach(cleanup);

  itDom('names itself with a heading that carries the connection', () => {
    const view = render(<PresencePanel me="kat" users={[]} connected={false} />);

    expect(screen.getByRole('heading', { name: 'Online (closed)' })).toBeDefined();

    view.rerender(<PresencePanel me="kat" users={[]} connected />);

    expect(screen.getByRole('heading', { name: 'Online (open)' })).toBeDefined();
  });

  itDom('says so while nobody has arrived', () => {
    render(<PresencePanel me="kat" users={[]} connected />);

    expect(screen.getByText('Nobody yet.')).toBeDefined();
  });

  itDom('lists who is online, and marks which one is you', () => {
    render(<PresencePanel me="kat" users={['kat', 'sam']} connected />);

    const roster = screen.getByRole('list');
    expect([...roster.querySelectorAll('li')].map((entry) => entry.textContent)).toEqual([
      'kat (you)',
      'sam',
    ]);
  });

  itDom('keeps the roster it was given while the connection is down', () => {
    // The old panel pinned this as a caveat it could not fix — its socket did
    // not reconnect, so a drop froze the roster and only a reload started
    // another. It is still what a reader sees *while* the socket is down, and
    // it is no longer where the story ends: the stream reconnects,
    // resubscribes and asks again. `reopens after a close it did not ask for`
    // and `asks who is there again on a reconnect` are the stream's.
    render(<PresencePanel me="kat" users={['kat', 'sam']} connected={false} />);

    expect(screen.getByRole('heading', { name: 'Online (closed)' })).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
