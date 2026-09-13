import { wsPresence } from '@wbs/contracts';

export interface PresenceSocket {
  send(s: string): void;
}

/** What a connection that has named no project is shown, and put in. */
const NOBODY: string[] = [];

interface Connected {
  username: string;
  socket: PresenceSocket;
  /**
   * The project this connection subscribed to, or null while it has named
   * none. See {@link Presence.enterProject} for why it is one and not a set.
   */
  projectId: string | null;
}

/**
 * Who is in a project right now, keyed by connection rather than by user: one
 * person with two tabs is two connections and must survive closing one of
 * them. `list()` therefore deduplicates, while `leave()` does not.
 *
 * **A roster is a project's, never the gateway's.** It used to be the gateway's:
 * `list()` returned every connected username with no filter at all, so a project
 * created a second ago showed every account that happened to have a socket open
 * — observed live, 2026-08-09, and the reason this class now knows what a
 * project is. A connection joins a roster by subscribing to `project:<id>`
 * ({@link enterProject}); until it does it belongs to **nothing** — it is in no
 * project's roster and is shown an empty one. That is the honest answer for a
 * socket that has connected and not yet said what it is looking at, and it is
 * the same answer for one whose token would not verify at `open`: no username
 * was recorded for it, so there is nothing to put anywhere.
 *
 * This is deliberately in-memory and per-process. gw-01 runs as a single
 * container per environment; the moment a second replica exists this becomes
 * a per-replica view and needs a shared backplane. That is a real limit, not
 * an oversight — it is why `list()` describes "this gateway", not "the system".
 */
export class Presence {
  private readonly byConnection = new Map<string, Connected>();
  /**
   * The connections in each project, so a roster is a lookup rather than a scan.
   *
   * `list()` filtered every connection the gateway holds, and `broadcast()`
   * calls it once per distinct project — O(connections × projects) per join,
   * per subscribe and per leave, on the one class that runs on every socket
   * event. Reads and delivery now visit only the affected projects’ members.
   *
   * Two indexes over one fact, which is a thing to keep honest rather than a
   * thing to be pleased about: every write below moves both, and
   * `presence.test.ts`'s `the two indexes never disagree` walks a thousand
   * random join/subscribe/move/leave sequences comparing `list()` against a
   * full scan.
   */
  private readonly byProject = new Map<string, Set<string>>();

  /** Replaces a connection id and returns the project its old connection left. */
  join(connectionId: string, username: string, socket: PresenceSocket): readonly string[] {
    const affected = this.leave(connectionId);
    this.byConnection.set(connectionId, { username, socket, projectId: null });
    // Proof: returning [] leaves linus without the updated roster in the renamed-id delivery case.
    return affected;
  }

  /** Removes one tab, identifying its previous project before deleting its lookup. */
  leave(connectionId: string): readonly string[] {
    const connected = this.byConnection.get(connectionId);
    const projectId = connected?.projectId;
    if (projectId != null) this.removeMember(projectId, connectionId);
    this.byConnection.delete(connectionId);
    // Proof: returning [] makes the two-tab disconnect case receive no roster.
    return projectId == null ? [] : [projectId];
  }

  /** Removes the member and retires an empty project's index entry. */
  private removeMember(projectId: string, connectionId: string): void {
    const members = this.membersOf(projectId);
    members.delete(connectionId);
    // Proof: retaining empty sets leaves size 2 instead of 0 after the mutation sequence.
    if (members.size === 0) this.byProject.delete(projectId);
  }

  /** The set for `projectId`, made on first use and never left empty behind. */
  private membersOf(projectId: string): Set<string> {
    const held = this.byProject.get(projectId);
    if (held !== undefined) return held;
    const made = new Set<string>();
    this.byProject.set(projectId, made);
    return made;
  }

  /**
   * Puts a connection in a project's roster, returning its changed old/new project ids.
   *
   * One project per connection, not a set: the roster answers "who else is
   * looking at this with me", and a socket showing one project at a time can
   * only be looking at one. A second `project:` subscribe on the same socket is
   * therefore a move — the browser switched project — rather than a second
   * membership, and a socket in two rosters would have no single roster to be
   * broadcast.
   *
   * A connection this does not know is one that never joined: its token did not
   * verify at `open` (see gw-01's `app.ts`), so it has no username and no
   * roster can hold it. Not an invariant failure — a modelled state of the
   * socket, and the only thing to do with it is nothing.
   */
  enterProject(connectionId: string, projectId: string): readonly string[] {
    const connected = this.byConnection.get(connectionId);
    // Proof: removing the equality guard sends frames during the real-socket no-op count check.
    if (connected === undefined || connected.projectId === projectId) return [];
    const previous = connected.projectId;
    if (previous !== null) this.removeMember(previous, connectionId);
    connected.projectId = projectId;
    this.membersOf(projectId).add(connectionId);
    // Proof: returning only the destination omits grace's roster in the real-socket move case.
    return previous === null ? [projectId] : [previous, projectId];
  }

  /**
   * Takes a connection out of its current project and returns that changed id.
   *
   * Guarded on the id rather than clearing outright: an `unsubscribe` naming a
   * project this connection has already moved off must not empty the roster of
   * the one it moved **to**. A browser that switches projects sends both frames
   * and their order is the network's, not ours.
   */
  leaveProject(connectionId: string, projectId: string): readonly string[] {
    const connected = this.byConnection.get(connectionId);
    if (connected?.projectId !== projectId) return [];
    connected.projectId = null;
    this.removeMember(projectId, connectionId);
    return [projectId];
  }

  /** Distinct usernames in `projectId`, sorted so the front end renders a stable order. */
  list(projectId: string): string[] {
    const names = new Set<string>();
    for (const connectionId of this.byProject.get(projectId) ?? []) {
      const held = this.connectionIn(projectId, connectionId);
      names.add(held.username);
    }
    return [...names].sort();
  }

  /**
   * The roster this connection is entitled to see: its own project's.
   *
   * Empty for a connection in no project, which is what a socket that has
   * connected and not yet subscribed gets when it asks `who`.
   */
  rosterFor(connectionId: string): string[] {
    const projectId = this.byConnection.get(connectionId)?.projectId;
    return projectId == null ? [...NOBODY] : this.list(projectId);
  }

  usernameOf(connectionId: string): string | null {
    return this.byConnection.get(connectionId)?.username ?? null;
  }

  get connectionCount(): number {
    return this.byConnection.size;
  }

  /** Sends one connected socket its current roster, including initial/reset empty state. */
  sendRoster(connectionId: string): void {
    const connected = this.byConnection.get(connectionId);
    if (connected !== undefined)
      this.send(connected.socket, wsPresence(this.rosterFor(connectionId)));
  }

  /**
   * Sends each affected project's roster only to its current members. Empty
   * projects have no recipients; unprojected sockets receive explicit initial
   * or reset state through {@link sendRoster}. Each project is serialized once.
   */
  broadcast(projectIds: readonly string[]): void {
    // Proof: restoring the global loop sends 1000 unrelated frames in the large
    // newcomer case; real-socket unrelated counts become [1,1,1,1] instead of zeros.
    for (const projectId of new Set(projectIds)) {
      const payload = wsPresence(this.list(projectId));
      for (const connectionId of this.byProject.get(projectId) ?? []) {
        this.send(this.connectionIn(projectId, connectionId).socket, payload);
      }
    }
  }

  /** A missing member is index drift, never an absent optional connection. */
  private connectionIn(projectId: string, connectionId: string): Connected {
    const connected = this.byConnection.get(connectionId);
    // Proof: omitting removeMember's deletion makes the two-tab disconnect case
    // throw "presence: tab1 is in project-hull but is not connected" here.
    if (connected === undefined) {
      throw new Error(`presence: ${connectionId} is in ${projectId} but is not connected`);
    }
    return connected;
  }

  /** A closed socket cannot stop remaining members from receiving their roster. */
  private send(socket: PresenceSocket, payload: string): void {
    try {
      socket.send(payload);
    } catch {
      // Dropped connection; leave arrives through the close handler.
    }
  }
}
