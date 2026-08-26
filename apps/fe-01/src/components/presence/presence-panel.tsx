import { useEffect, useRef, useState } from 'react';

import { websocketUrl } from '@/lib/api';

type Status = 'connecting' | 'open' | 'closed';

/**
 * Who else is in this project, in the header bar.
 *
 * Presence is push-only after the first frame: the gateway broadcasts the
 * roster whenever anyone joins or leaves. `who` is sent once on open so a
 * client that connects into a quiet room still sees who is already there
 * rather than an empty list until the next join.
 *
 * **The panel says which project it is watching, and that is what scopes the
 * roster.** It used to say nothing, and gw-01's roster was every username
 * connected to the gateway — a project one second old listed accounts that had
 * never opened it (F4, observed live 2026-08-09). The `subscribe` frame is the
 * gateway's existing way of saying "this socket is looking at this project",
 * and gw-01's `Presence` now scopes by it; a panel with no project selected
 * sends none and is shown nobody, which is the honest roster for a browser that
 * is not in a project yet.
 *
 * **The socket is one per project**, torn down and reopened when the selection
 * changes rather than kept and re-subscribed. Reconnect is the state machine
 * this panel deliberately does not have (below), and a socket whose
 * subscription is edited in place would be the start of one.
 *
 * **The socket does not reconnect, and `H header-fits-a-row` deliberately did
 * not fix that.** A dropped connection leaves `closed` in the heading and the
 * roster frozen at whoever was there when it went; only a reload starts
 * another socket. That is the pre-existing caveat, carried across the move into
 * the header unchanged so the move is a move and not a behaviour change wearing
 * one — `openspec/changes/header-fits-a-row/proposal.md` names it as a
 * non-goal. It is pinned by `says the connection has closed, and starts no
 * other`, so the day somebody adds a reconnect they will be changing an
 * assertion rather than discovering one.
 *
 * The shape is a header row's: the heading is the small grey label, the roster
 * is one clipped line beside it. Bounded width is structural rather than
 * cosmetic — an unbounded list of names is the one thing in the bar that grows
 * with the world rather than with the layout, and it would wrap the header onto
 * a second row for a busy project, which is exactly what this change exists to
 * stop.
 */
export interface PresencePanelProps {
  me: string;
  /** The project whose roster this shows, or null while none is selected. */
  projectId: string | null;
}

export function PresencePanel({ me, projectId }: PresencePanelProps) {
  const [users, setUsers] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // The roster is the previous project's until this socket answers, and
    // showing it under the new project's name would be the same lie in
    // miniature that scoping exists to stop.
    setUsers([]);
    setStatus('connecting');
    const ws = new WebSocket(websocketUrl());
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      // Subscribe first, then ask: `who` is answered with this connection's own
      // project, so a `who` that overtook the subscribe would be answered with
      // nobody and the panel would sit empty until the next join.
      if (projectId !== null) {
        ws.send(JSON.stringify({ type: 'subscribe', subscription: `project:${projectId}` }));
      }
      ws.send(JSON.stringify({ type: 'who' }));
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; users?: string[] };
        if (msg.type === 'presence' && Array.isArray(msg.users)) setUsers(msg.users);
      } catch {
        // A frame this client does not understand is not a reason to tear the
        // connection down.
      }
    };
    ws.onclose = () => {
      setStatus('closed');
    };

    return () => {
      ws.close();
    };
  }, [projectId]);

  return (
    <section className="flex min-w-0 items-center gap-2 text-xs">
      <h2 className="text-muted-foreground shrink-0 font-medium">
        Online <small className="font-normal">({status})</small>
      </h2>
      {users.length === 0 ? (
        <p className="text-muted-foreground">Nobody yet.</p>
      ) : (
        <ul className="m-0 flex max-w-48 list-none gap-2 overflow-hidden p-0 whitespace-nowrap">
          {users.map((u) => (
            <li key={u}>
              {u}
              {u === me && <span className="text-muted-foreground"> (you)</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
