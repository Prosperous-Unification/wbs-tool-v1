import type { OidcConsumeResult, OidcTransactionStore } from './oidc-store';

/**
 * **One browser, several logins, one cookie name** (TASK-272).
 *
 * `InMemoryOidcTransactionStore` addresses a transaction by the binding alone
 * and that is correct; what was not correct is that a browser could only
 * ever *hold* one. Two tabs starting a login share `__Host-wbs_oidc`, so the
 * second overwrites the first and the first tab's callback comes back carrying a
 * binding that is not its own. TASK-276 stopped that arrival from destroying
 * the second tab's login; it could not give the first tab back a cookie the
 * browser had already replaced. This module is that half: the cookie's **value**
 * becomes a bounded ordered list, so a browser offers every binding it still
 * holds and the store decides which one the arriving `state` proves.
 *
 * **A cookie per login is the stronger shape and is not what this is** — said
 * plainly, because the first version of this paragraph claimed a security
 * objection it does not have. A per-login cookie *name*
 * (`__Host-wbs_oidc_<id>`) does let the arriving URL select which cookie the
 * browser is asked for, but what it selects is *which* proof is offered, never
 * what it is: the value stays `HttpOnly` and unguessable, the store still
 * compares the state, and naming a cookie the browser does not hold earns the
 * same refusal. Its real costs are a cookie jar that grows and a bound that has
 * to be kept by clearing names.
 *
 * Its real advantage is the one this shape does not have. A single cookie is a
 * read-modify-write across a round trip, so two logins starting at the same
 * instant can both read the same list and the later answer wins — a lost update
 * that costs the other login (peer review, TASK-272 r1, Important). Distinct
 * names make those writes independent, and moving to them is the recorded next
 * step for this task rather than a thing this comment can talk its way out of.
 *
 * Single-use is unmoved either way. It is still keyed by the binding and still
 * enforced in the store; only the transport becomes plural.
 */
export const MAX_BROWSER_BINDINGS = 3;

/**
 * `.` because it cannot occur inside a binding and survives the cookie round
 * trip untouched: bindings are `randomBytes(32).toString('base64url')`
 * (`auth.routes.ts`), whose alphabet is `A-Za-z0-9-_`, and `encodeURIComponent`
 * leaves `.` unescaped, so what the browser sends back splits the same way it
 * was written.
 */
const BINDING_SEPARATOR = '.';

/**
 * The bindings a browser is still holding, newest last.
 *
 * Truncating to {@link MAX_BROWSER_BINDINGS} here and not only when writing is
 * deliberate: `__Host-` means only this origin can set the cookie, so an
 * oversized value is not an attack, but reading a bound the writer promised is
 * cheaper than trusting that nothing ever wrote more — and it caps how many
 * store lookups one callback can ask for at the number this module publishes.
 */
export function parseBrowserBindings(cookieValue: string | null): string[] {
  if (cookieValue === null) return [];
  const seen = new Set<string>();
  for (const part of cookieValue.split(BINDING_SEPARATOR)) {
    if (part !== '') seen.add(part);
  }
  return [...seen].slice(-MAX_BROWSER_BINDINGS);
}

/**
 * The list a new login leaves behind: the new binding last, the oldest dropped
 * once the browser is already holding {@link MAX_BROWSER_BINDINGS}.
 *
 * **The bound is on the cookie, not on the store.** The dropped binding's
 * record is left to expire rather than deleted, because this function is not
 * told which store holds it and because the browser is the only thing that
 * could still present it — a record nobody can address is already unreachable
 * and the TTL sweeps it. What the bound buys is that the cookie cannot grow
 * without limit and that a person who abandons tabs loses the *oldest* login
 * rather than the one they are completing.
 *
 * Throws when a binding contains the separator. It cannot happen with the
 * configured randomness, and the alternative — writing a value that reads back
 * as two bindings, neither of which addresses anything — would turn a
 * misconfigured `random` into logins that silently never complete.
 */
export function withBrowserBinding(bindings: readonly string[], binding: string): string[] {
  if (binding === '' || binding.includes(BINDING_SEPARATOR)) {
    throw new Error('OIDC browser binding must not be empty or contain a separator');
  }
  const kept = bindings.filter((held) => held !== binding);
  return [...kept, binding].slice(-MAX_BROWSER_BINDINGS);
}

export function serializeBrowserBindings(bindings: readonly string[]): string {
  return bindings.join(BINDING_SEPARATOR);
}

/**
 * What one callback's bindings came to: the store's single answer for this
 * arrival, and the bindings the browser should still be holding after it.
 *
 * The two travel together because the caller cannot derive one from the other —
 * `remaining` is not "the bindings minus the consumed one", it is also missing
 * the ones whose records were gone, and it is the whole list when nothing
 * matched.
 */
export interface BrowserBindingConsumeResult {
  /** The bindings the browser should still be holding after this answer. */
  readonly remaining: string[];
  /** The one outcome this callback earned. See {@link OidcConsumeResult}. */
  readonly transaction: OidcConsumeResult;
}

/**
 * Offer every binding this browser holds and keep the one answer that matters.
 *
 * Precedence is `consumed` > `state_mismatch` > `expired` > `missing`, and each
 * step of it is a decision:
 *
 * - **At most one record is consumed.** Once a binding matches, the rest are
 *   returned to the cookie unread. A single callback carries a single `state`,
 *   so a second match is impossible with 256-bit states; not asking is how that
 *   stays true rather than something the randomness happens to buy.
 * - **A mismatch keeps its binding** — the property TASK-276 bought. A callback
 *   that fails to prove it owns a live record leaves the record *and* the
 *   cookie alone, so a hostile `SameSite=Lax` navigation to
 *   `?error=…&state=anything` now costs the browser nothing, however many
 *   logins it is holding.
 * - **`missing` and `expired` drop their binding.** The record is gone for
 *   everyone, so the cookie is carrying a string that can never address
 *   anything again; keeping it would spend one of the browser's
 *   {@link MAX_BROWSER_BINDINGS} slots on nothing. Expiry deletion itself is
 *   the store's and is untouched.
 * - **`expired` outranks `missing`** for the same reason the store distinguishes
 *   them: it is the more specific true statement about what the browser had.
 */
export function consumeBrowserBinding(
  store: OidcTransactionStore,
  bindings: readonly string[],
  state: string,
): BrowserBindingConsumeResult {
  const remaining: string[] = [];
  let consumed: OidcConsumeResult | null = null;
  let mismatched = false;
  let expired = false;

  for (const binding of bindings) {
    if (consumed !== null) {
      remaining.push(binding);
      continue;
    }
    const offered = store.consume(binding, state);
    if (offered.outcome === 'consumed') {
      consumed = offered;
      continue;
    }
    if (offered.outcome === 'state_mismatch') {
      mismatched = true;
      remaining.push(binding);
      continue;
    }
    if (offered.outcome === 'expired') expired = true;
  }

  if (consumed !== null) return { remaining, transaction: consumed };
  if (mismatched) return { remaining, transaction: { outcome: 'state_mismatch' } };
  return { remaining, transaction: { outcome: expired ? 'expired' : 'missing' } };
}
