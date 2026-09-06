import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import { Presence } from './presence';

const socket = () => {
  const sent: string[] = [];
  return { sent, send: (s: string) => sent.push(s) };
};

const HULL = 'project-hull';
const KEEL = 'project-keel';

/** A connection that has joined and named the project it is looking at. */
function inProject(p: Presence, connectionId: string, username: string, projectId: string) {
  const s = socket();
  p.join(connectionId, username, s);
  p.enterProject(connectionId, projectId);
  return s;
}

const rosterIn = (s: { sent: string[] }): string[] =>
  (JSON.parse(s.sent.at(-1) ?? '{}') as { users?: string[] }).users ?? [];

describe('Presence', () => {
  it('lists a joined user once per name, not once per connection', () => {
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);
    inProject(p, 'c2', 'ada', HULL);
    inProject(p, 'c3', 'grace', HULL);
    expect(p.list(HULL)).toEqual(['ada', 'grace']);
    expect(p.connectionCount).toBe(3);
  });

  it('keeps a user online while any of their connections remains', () => {
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);
    inProject(p, 'c2', 'ada', HULL);
    p.leave('c1');
    expect(p.list(HULL)).toEqual(['ada']);
    p.leave('c2');
    expect(p.list(HULL)).toEqual([]);
  });

  it('broadcasts the roster to every connection', () => {
    const p = new Presence();
    const a = inProject(p, 'c1', 'ada', HULL);
    const b = inProject(p, 'c2', 'grace', HULL);
    p.broadcast([HULL, KEEL]);
    const expected = JSON.stringify({ type: 'presence', users: ['ada', 'grace'] });
    expect(a.sent.at(-1)).toBe(expected);
    expect(b.sent.at(-1)).toBe(expected);
  });

  it('still reaches the other clients when one socket throws', () => {
    const p = new Presence();
    const good = socket();
    p.join('c1', 'broken', {
      send: () => {
        throw new Error('socket closed');
      },
    });
    p.enterProject('c1', HULL);
    p.join('c2', 'ada', good);
    p.enterProject('c2', HULL);
    expect(() => {
      p.broadcast([HULL, KEEL]);
    }).not.toThrow();
    expect(good.sent).toHaveLength(1);
  });

  it('resolves the username behind a connection id', () => {
    const p = new Presence();
    p.join('c1', 'ada', socket());
    expect(p.usernameOf('c1')).toBe('ada');
    expect(p.usernameOf('missing')).toBeNull();
  });
});

describe('a roster is a project’s, not the gateway’s', () => {
  it('shows each project only the names in it', () => {
    // F4, observed live 2026-08-09: a project created a second ago listed every
    // account with a socket open on this gateway.
    //
    // Proof: the `projectId` filter struck from `Presence.list` — the body left
    // as the old `[...new Set(values().map(username))].sort()`. This test failed
    // on `expect(p.list(HULL)).toEqual(['ada', 'grace'])`, receiving
    // `['ada', 'grace', 'linus']`, and the two `rosterFor` expectations below
    // failed with the other project's names in them. Watched 2026-08-09.
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);
    inProject(p, 'c2', 'grace', HULL);
    inProject(p, 'c3', 'linus', KEEL);

    expect(p.list(HULL)).toEqual(['ada', 'grace']);
    expect(p.list(KEEL)).toEqual(['linus']);
    expect(p.rosterFor('c1')).toEqual(['ada', 'grace']);
    expect(p.rosterFor('c3')).toEqual(['linus']);
  });

  it('broadcasts each socket its own project’s names and no others', () => {
    const p = new Presence();
    const ada = inProject(p, 'c1', 'ada', HULL);
    const linus = inProject(p, 'c2', 'linus', KEEL);

    p.broadcast([HULL, KEEL]);

    expect(rosterIn(ada)).toEqual(['ada']);
    expect(rosterIn(linus)).toEqual(['linus']);
  });

  it('moves a connection when it switches project', () => {
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);
    inProject(p, 'c2', 'grace', HULL);
    const linus = inProject(p, 'c3', 'linus', KEEL);

    p.enterProject('c3', HULL);

    // In the new list, and out of the old one — a switch is a move, not a
    // second membership.
    expect(p.list(HULL)).toEqual(['ada', 'grace', 'linus']);
    expect(p.list(KEEL)).toEqual([]);
    p.broadcast([HULL, KEEL]);
    expect(rosterIn(linus)).toEqual(['ada', 'grace', 'linus']);
  });

  it('puts a connection that has named no project in nobody’s roster', () => {
    const p = new Presence();
    const lurker = socket();
    p.join('c1', 'mallory', lurker);
    inProject(p, 'c2', 'ada', HULL);

    expect(p.list(HULL)).toEqual(['ada']);
    expect(p.rosterFor('c1')).toEqual([]);
    p.broadcast([HULL, KEEL]);
    p.sendRoster('c1');
    // Told, rather than left silent: an empty roster is an answer, and the
    // panel says "Nobody yet." on it.
    expect(rosterIn(lurker)).toEqual([]);
  });

  it('knows nothing about a connection that never joined', () => {
    // The socket whose token did not verify at `open`. It has no username, so
    // there is nothing to put in a roster and nothing to take out of one.
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);

    p.enterProject('unknown-connection', HULL);
    p.leaveProject('unknown-connection', HULL);

    expect(p.list(HULL)).toEqual(['ada']);
    expect(p.rosterFor('unknown-connection')).toEqual([]);
  });

  it('takes a connection out of the project it leaves', () => {
    const p = new Presence();
    inProject(p, 'c1', 'ada', HULL);
    inProject(p, 'c2', 'grace', HULL);

    p.leaveProject('c2', HULL);

    expect(p.list(HULL)).toEqual(['ada']);
    expect(p.rosterFor('c2')).toEqual([]);
  });

  it('ignores an unsubscribe from a project the connection has already left', () => {
    // A browser that switches project sends `subscribe` and `unsubscribe`, and
    // their order on the wire is the network's. A late unsubscribe for the old
    // project must not empty the roster of the new one.
    //
    // Proof: the `?.projectId === projectId` guard in `leaveProject` replaced
    // with an unconditional clear. This test failed on
    // `expect(p.list(KEEL)).toEqual(['grace'])`, receiving `[]`.
    const p = new Presence();
    inProject(p, 'c1', 'grace', HULL);
    p.enterProject('c1', KEEL);

    p.leaveProject('c1', HULL);

    expect(p.list(KEEL)).toEqual(['grace']);
  });
});

/**
 * The per-project index and a full scan agree, whatever happens to a socket.
 *
 * `list()` filtered every connection the gateway holds until 2026-09-02, and
 * `broadcast()` calls it once per distinct project — so a join, a subscribe or a
 * leave cost O(connections × projects) on the one class that runs on every
 * socket event. It is a `Map<projectId, Set<connectionId>>` now, which means
 * **two indexes over one fact**, and the fault that shape has is drift: a
 * connection left in a project's set, or taken out of the wrong one.
 *
 * So this is a differential rather than a set of examples: a thousand random
 * sequences of join, subscribe, move, unsubscribe and leave, comparing every
 * project's roster against the scan the class used to do.
 *
 * Proof, both watched 2026-09-02 and both caught by an **existing** case as
 * well as by this one. The set removal taken out of `leave` fails `keeps a user
 * online while any of their connections remains` on `presence: c1 is in
 * project-hull but is not connected` — the throw `list` keeps for exactly this
 * drift. Taken out of `enterProject`, it fails `moves a connection when it
 * switches project` on `+ Received + 3` and the differential below: a
 * connection that moved still counted in the project it left.
 */
describe('the two indexes never disagree', () => {
  const PROJECTS = ['p1', 'p2', 'p3'];

  it('over a thousand random socket sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            connection: fc.integer({ min: 0, max: 5 }),
            project: fc.integer({ min: 0, max: 2 }),
            what: fc.constantFrom('join', 'subscribe', 'unsubscribe', 'leave'),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (steps) => {
          const presence = new Presence();
          /** What the class did before the index existed. */
          const byScanning = (projectId: string): string[] =>
            [
              ...new Set(
                [...seen.entries()]
                  .filter(([, at]) => at === projectId)
                  .map(([connectionId]) => `u${connectionId.slice(1)}`),
              ),
            ].sort();
          const seen = new Map<string, string | null>();

          for (const step of steps) {
            const connectionId = `c${String(step.connection)}`;
            const projectId = PROJECTS[step.project] ?? 'p1';
            if (step.what === 'join') {
              presence.join(connectionId, `u${String(step.connection)}`, { send: () => undefined });
              seen.set(connectionId, null);
            } else if (step.what === 'subscribe') {
              presence.enterProject(connectionId, projectId);
              if (seen.has(connectionId)) seen.set(connectionId, projectId);
            } else if (step.what === 'unsubscribe') {
              presence.leaveProject(connectionId, projectId);
              if (seen.get(connectionId) === projectId) seen.set(connectionId, null);
            } else {
              presence.leave(connectionId);
              seen.delete(connectionId);
            }
          }

          for (const projectId of PROJECTS) {
            expect(presence.list(projectId)).toEqual(byScanning(projectId));
          }
        },
      ),
      { numRuns: 1_000, seed: 20_260_902 },
    );
  });
});

it('identifies only changed projects across join, move, reset, rejoin and disconnect', () => {
  const p = new Presence();
  expect(p.join('c1', 'ada', socket())).toEqual([]);
  expect(p.enterProject('c1', HULL)).toEqual([HULL]);
  expect(p.enterProject('c1', HULL)).toEqual([]);
  expect(p.enterProject('c1', KEEL)).toEqual([HULL, KEEL]);
  expect(p.leaveProject('c1', HULL)).toEqual([]);
  expect(p.leaveProject('c1', KEEL)).toEqual([KEEL]);
  expect(p.leaveProject('c1', KEEL)).toEqual([]);
  expect(p.enterProject('c1', HULL)).toEqual([HULL]);
  expect(p.join('c1', 'grace', socket())).toEqual([HULL]);
  expect(p.list(HULL)).toEqual([]);
  expect(p.usernameOf('c1')).toBe('grace');
  expect(p.enterProject('c1', KEEL)).toEqual([KEEL]);
  expect(p.leave('c1')).toEqual([KEEL]);
  expect(p.leave('c1')).toEqual([]);
  expect(p.enterProject('missing', HULL)).toEqual([]);
  expect(p.leaveProject('missing', HULL)).toEqual([]);
  expect((p as unknown as { byProject: Map<string, Set<string>> }).byProject.size).toBe(0);
});

it('sends an unprojected newcomer one initial roster and zero frames to 1000 connections in 100 projects', () => {
  const p = new Presence();
  const existing = Array.from({ length: 1000 }, (_, n) =>
    inProject(p, `c${String(n)}`, `u${String(n)}`, `p${String(n % 100)}`),
  );
  const newcomer = socket();
  const affected = p.join('new', 'newcomer', newcomer);
  p.broadcast(affected);
  expect(existing.reduce((count, s) => count + s.sent.length, 0)).toBe(0);
  p.sendRoster('new');
  expect(newcomer.sent).toEqual([JSON.stringify({ type: 'presence', users: [] })]);
});

it('delivers only to affected members and resets a renamed connection after its own unsubscribe', () => {
  const p = new Presence();
  const ada = inProject(p, 'ada', 'ada', HULL);
  const grace = inProject(p, 'grace', 'grace', HULL);
  const linus = inProject(p, 'linus', 'linus', KEEL);
  const other = inProject(p, 'other', 'other', 'unrelated');
  p.broadcast(p.enterProject('ada', KEEL));
  expect(ada.sent).toHaveLength(1);
  expect(grace.sent).toEqual([JSON.stringify({ type: 'presence', users: ['grace'] })]);
  expect(linus.sent).toEqual([JSON.stringify({ type: 'presence', users: ['ada', 'linus'] })]);
  expect(other.sent).toEqual([]);
  for (const s of [ada, grace, linus]) s.sent.length = 0;
  p.broadcast(p.enterProject('ada', KEEL));
  p.broadcast(p.leaveProject('ada', HULL));
  expect([ada.sent.length, grace.sent.length, linus.sent.length, other.sent.length]).toEqual([
    0, 0, 0, 0,
  ]);

  const renamed = socket();
  p.broadcast(p.join('ada', 'renamed', renamed));
  p.sendRoster('ada');
  expect(ada.sent).toEqual([]);
  expect(linus.sent).toEqual([JSON.stringify({ type: 'presence', users: ['linus'] })]);
  expect(renamed.sent).toEqual([JSON.stringify({ type: 'presence', users: [] })]);
  p.broadcast(p.enterProject('ada', HULL));
  for (const s of [renamed, grace, linus]) s.sent.length = 0;
  const left = p.leaveProject('ada', HULL);
  p.broadcast(left);
  if (left.length > 0) p.sendRoster('ada');
  expect(renamed.sent).toEqual([JSON.stringify({ type: 'presence', users: [] })]);
  expect(grace.sent).toEqual([JSON.stringify({ type: 'presence', users: ['grace'] })]);
  expect([ada.sent.length, linus.sent.length, other.sent.length]).toEqual([0, 0, 0]);
});

it('disconnects one tab through its project lookup while keeping the duplicate username', () => {
  const p = new Presence();
  const departing = inProject(p, 'tab1', 'ada', HULL);
  const remaining = inProject(p, 'tab2', 'ada', HULL);
  const unrelated = inProject(p, 'other', 'grace', KEEL);
  p.broadcast(p.leave('tab1'));
  expect(remaining.sent).toEqual([JSON.stringify({ type: 'presence', users: ['ada'] })]);
  expect(departing.sent).toEqual([]);
  expect(unrelated.sent).toEqual([]);
  expect(p.connectionCount).toBe(2);
});
