/**
 * Who else is in this project, and whether the socket saying so is up.
 *
 * Presence is push-only after the first frame: gw-01 broadcasts the roster
 * whenever anyone joins or leaves, and the `who` the stream sends on open is
 * what a client entering a quiet room is answered with.
 *
 * **The roster is a project's**, scoped by the `subscribe` frame — gw-01's
 * roster was every username connected to the *gateway* until F4, so a project
 * one second old listed accounts that had never opened it (observed live
 * 2026-08-09).
 */
export interface Roster {
  users: readonly string[];
  /** Whether the socket carrying the roster is up — see {@link PresencePanel}. */
  connected: boolean;
}

export interface PresencePanelProps extends Roster {
  me: string;
}

/**
 * The roster, in the header bar.
 *
 * **It opens no socket, and that is the change of 2026-09-02.** It held its own
 * WebSocket per project until then — a second connection per browser, a second
 * `subscribe`, a second entry in the gateway's fan-out, to be told the same
 * thing by the same gateway the table was already listening to. The roster
 * arrives on the plan's own stream now (`subscribeToProject`'s `onPresence`),
 * and `ProjectPage` holds it because it renders both halves of the screen.
 *
 * Two things follow, and the second was a caveat this file used to carry:
 *
 * - A page with no project open shows nobody, because nothing subscribes.
 * - **A dropped connection recovers.** The old socket did not reconnect, so the
 *   roster froze at whoever was there and only a reload started another; the
 *   stream reconnects, resubscribes and asks again.
 *
 * The shape is a header row's: the heading is the small grey label, the roster
 * is one clipped line beside it. Bounded width is structural rather than
 * cosmetic — an unbounded list of names is the one thing in the bar that grows
 * with the world rather than with the layout, and it would wrap the header onto
 * a second row for a busy project.
 */
export function PresencePanel({ me, users, connected }: PresencePanelProps) {
  return (
    <section className="flex min-w-0 items-center gap-2 text-xs">
      <h2 className="text-muted-foreground shrink-0 font-medium">
        Online <small className="font-normal">({connected ? 'open' : 'closed'})</small>
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
