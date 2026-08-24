import { describe, expect, it } from 'vitest';

import { entryMeta, matchingProjects, projectCardMeta } from './project-picker';

/**
 * The entries as the page really hands them over — meta and all.
 *
 * Not `{ id, name }` pairs: the claim below is that the owner's name is
 * **there** and is still not searched, and a fixture that left it out would
 * make that test pass by having nothing to match against.
 */
const projects = [
  { id: 'p1', name: 'Rewire the shed', ownerName: 'kat', createdAt: 1_780_000_000_000 },
  { id: 'p2', name: 'Repaint the hall', ownerName: 'strip', createdAt: 1_780_000_000_000 },
  { id: 'p3', name: 'HALLWAY lighting', ownerName: 'kat', createdAt: 1_780_000_000_000 },
];

describe('matchingProjects', () => {
  it('offers everything when nothing is typed', () => {
    expect(matchingProjects(projects, '').map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(matchingProjects(projects, '   ').map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('matches a substring of the name, ignoring case', () => {
    expect(matchingProjects(projects, 'hall').map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(matchingProjects(projects, 'SHED').map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps the order it was given rather than sorting by name or match', () => {
    // The server's order is this account's recency order. A picker that
    // re-sorted would quietly overrule it — `hall` matching `Repaint the hall`
    // at position 8 and `HALLWAY lighting` at position 0 must not promote the
    // second one.
    const reversed = [...projects].reverse();
    expect(matchingProjects(reversed, 'hall').map((p) => p.id)).toEqual(['p3', 'p2']);
  });

  it('offers nothing when nothing matches', () => {
    expect(matchingProjects(projects, 'garage')).toEqual([]);
  });

  it('never matches an owner, however plainly the entry shows one', () => {
    // The recorded non-goal, made breakable. `strip` owns `Repaint the hall`
    // and the entry says so on screen; typing it must still offer nothing,
    // because the box narrows by name and nothing tells anybody otherwise.
    // `kat` is the second half of the same claim — she owns two, so a filter
    // reading the owner would answer with a pair rather than with an empty
    // list, and an assertion about emptiness alone could not tell the two
    // faults apart.
    expect(matchingProjects(projects, 'strip')).toEqual([]);
    expect(matchingProjects(projects, 'kat')).toEqual([]);
    // And the name still matches, which is what stops the check above being
    // satisfied by a filter that has stopped matching anything at all.
    expect(matchingProjects(projects, 'shed').map((p) => p.id)).toEqual(['p1']);
  });
});

describe('projectCardMeta', () => {
  // The card reads a fixed calendar day `startDate` and two instants
  // (`createdAt`, `lastOpenedAt`); the dates are built rather than pinned so
  // the assertions hold in any zone the suite runs in.
  const reading = new Date(2026, 0, 15);
  const entry = {
    ownerName: 'kat',
    createdAt: new Date(2025, 11, 1, 12).getTime(),
    startDate: '2026-03-12',
    lastOpenedAt: new Date(2026, 0, 10, 9).getTime(),
  };

  it('prints ownership, the start day and the last open', () => {
    expect(projectCardMeta(entry, reading)).toEqual({
      ownership: '(kat · 1 Dec 2025)',
      start: 'Start 12 Mar',
      lastOpened: 'Last opened 10 Jan',
    });
  });

  it('says so rather than printing nothing for a plan with no start day', () => {
    expect(projectCardMeta({ ...entry, startDate: null }, reading).start).toBe('Not scheduled');
  });

  it('says so rather than printing nothing for a project never opened', () => {
    expect(projectCardMeta({ ...entry, lastOpenedAt: null }, reading).lastOpened).toBe(
      'Never opened',
    );
  });

  it('reads the start day as a calendar day, not as a moment', () => {
    // A `startDate` parsed as a moment lands on midnight UTC and prints a day
    // early west of Greenwich — the fault `shortIsoDate` exists to refuse. The
    // card goes through it, so a zone-free day stays the same day everywhere.
    expect(projectCardMeta({ ...entry, startDate: '2026-03-01' }, reading).start).toBe(
      'Start 1 Mar',
    );
  });
});

describe('entryMeta', () => {
  it('reads the creation instant in the reader’s own zone, not as a calendar day', () => {
    // The formatter is chosen by the **type** of the value: `createdAt` is an
    // epoch millisecond, so this is `shortInstant`. Building the moment here
    // rather than pinning an epoch keeps the assertion true in every zone the
    // suite runs in — the day is whatever the reader's machine says it is,
    // which is `short-date.test.ts`'s stated cost and not this file's to
    // re-decide.
    const madeOn = new Date(2027, 5, 1, 12);
    const reading = new Date(2026, 0, 15);

    expect(entryMeta({ ownerName: 'kat', createdAt: madeOn.getTime() }, reading)).toBe(
      '(kat · 1 Jun 2027)',
    );
    expect(entryMeta({ ownerName: 'kat', createdAt: madeOn.getTime() }, madeOn)).toBe(
      '(kat · 1 Jun)',
    );
  });
});
