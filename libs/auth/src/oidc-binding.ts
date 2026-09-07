import { createHash } from 'node:crypto';

import type { OidcConsumeResult, OidcTransactionStore } from './oidc-store';

/**
 * **One browser, several logins, one cookie each** (TASK-272).
 *
 * `InMemoryOidcTransactionStore` addresses a transaction by the binding alone
 * and that is correct; what was not correct is that a browser could only ever
 * hold one. Two tabs starting a login shared `__Host-wbs_oidc`, so the second
 * overwrote the first and the first tab's callback came back carrying a binding
 * that was not its own. TASK-276 stopped that arrival from destroying the
 * second tab's login; it could not give the first tab back a cookie the browser
 * had already replaced. This module is that half: a login writes its binding
 * under a name no other login uses, so a browser offers every binding it still
 * holds and the store decides which one the arriving `state` proves.
 *
 * **The first shape tried here was one cookie whose value was a bounded list**,
 * and it is recorded because its cost is the reason for the names. A single
 * cookie is a read-modify-write across a round trip: two logins starting at the
 * same instant both read the same list and the later `Set-Cookie` wins, and a
 * callback that writes back the list its own request carried erases any login
 * started while it was in flight. Both are lost updates on an auth path and the
 * peer review called the first one Important (TASK-272 r1). Distinct names have
 * no lost update to have, because no two writers ever name the same cookie.
 *
 * **What distinct names cost, honestly.** The cookie jar grows with concurrent
 * logins instead of one value growing, so the bound has to be kept by clearing
 * names rather than by truncating a list. {@link selectBrowserBindings} decides
 * which names those are; the login route emits the clears it names, and is the
 * only other reader of this number. The earlier version of
 * this comment also claimed a security objection to per-login names that does
 * not exist: deriving a name from the URL's `state` would let the arriving
 * request select *which* proof is offered, never what it is. That objection is
 * moot here anyway, because {@link browserBindingCookieName} derives the name
 * from the binding and the callback reads every name it finds, so no part of
 * the request chooses anything.
 *
 * **A deploy across this change costs in-flight logins one retry.** The old
 * `__Host-wbs_oidc` is not this prefix, so a browser mid-login when the new
 * code arrives offers nothing, is refused, and starts again; the orphan cookie
 * is left to its five-minute `Max-Age` rather than cleared on every login
 * forever.
 *
 * Single-use is unmoved throughout. It is still keyed by the binding and still
 * enforced in the store; only the transport became plural.
 */
export const MAX_BROWSER_BINDINGS = 3;

/**
 * The name every in-flight login's cookie starts with, and the whole of what a
 * callback needs to find them.
 *
 * `__Host-` is kept for what it has always bought: only this exact origin can
 * set one, over TLS, with `Path=/` and no `Domain`, so a sibling host or a
 * subdomain cannot write a binding into this browser's jar under any name.
 */
export const BROWSER_BINDING_COOKIE_PREFIX = '__Host-wbs_oidc_';

/**
 * The cookie name a binding is written under: the prefix and 64 bits of the
 * binding's SHA-256.
 *
 * **Derived from the binding rather than drawn from `random()`,** so the name
 * and the value are one fact instead of two that a callback would have to keep
 * paired across a round trip. Anything holding a binding can recompute its
 * name — the login route knows which names it may clear, the callback knows
 * which name held the binding it just spent — and it adds no new randomness to
 * reason about. The mapping only runs that way: a name does not yield its
 * binding, and two bindings are distinguished by it only in practice, for the
 * reason below.
 *
 * **What it publishes, stated exactly.** The name is 64 bits of the binding's
 * SHA-256, so it is a fingerprint rather than nothing: an observer who saw it
 * would hold those 64 bits. That is not a weakening — SHA-256 is preimage
 * resistant and the binding under it is 256 bits of `randomBytes`, so the name
 * yields no path back to the value, and the name is `HttpOnly` beside its value
 * anyway, so script can read neither. For the same reason the name/value
 * mapping is one-to-one **in practice** rather than by construction: two
 * distinct bindings collide with probability about 2^-64, and a collision would
 * cost one browser one login, not any confusion between browsers. So this is a
 * one-way, practically-injective mapping rather than a bijection, and the word
 * is avoided deliberately.
 */
export function browserBindingCookieName(binding: string): string {
  if (binding === '') throw new Error('OIDC browser binding must not be empty');
  return `${BROWSER_BINDING_COOKIE_PREFIX}${createHash('sha256').update(binding).digest('hex').slice(0, 16)}`;
}

/** One login's cookie as the browser sent it back. */
export interface HeldBrowserBinding {
  /** The cookie's name, which is what a caller clears to evict this login. */
  readonly cookieName: string;
  /** The binding itself, decoded, which is what the store is addressed by. */
  readonly binding: string;
}

/**
 * Every binding cookie in a request, decoded.
 *
 * A value that will not decode is dropped rather than thrown on, matching
 * `cookieValue`'s reading: a cookie nobody can decode is not a binding, and a
 * `URIError` out of a route handler would be a 500 about a malformed request.
 * The pair is dropped rather than reported because a caller cannot do anything
 * with it but clear it, and {@link selectBrowserBindings} clears the names it
 * is given — so an undecodable value is instead left to its own `Max-Age`,
 * which is the same five minutes.
 */
export function browserBindingsIn(
  cookies: Iterable<readonly [string, string]>,
): HeldBrowserBinding[] {
  const held: HeldBrowserBinding[] = [];
  for (const [cookieName, raw] of cookies) {
    if (!cookieName.startsWith(BROWSER_BINDING_COOKIE_PREFIX)) continue;
    let binding: string;
    try {
      binding = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (binding !== '') held.push({ binding, cookieName });
  }
  return held;
}

/**
 * What a request's binding cookies came to: the ones worth offering the store,
 * and the ones the answer should clear.
 */
export interface BrowserBindingSelection {
  /**
   * The live bindings, oldest expiry first, at most {@link MAX_BROWSER_BINDINGS}
   * of them.
   */
  readonly offered: HeldBrowserBinding[];
  /**
   * The names this browser should stop holding: the ones addressing nothing,
   * and the still-live ones past {@link MAX_BROWSER_BINDINGS} that `offered`
   * has already made unreachable.
   */
  readonly surplus: HeldBrowserBinding[];
}

/**
 * Decide which of a browser's binding cookies are live and which are litter.
 *
 * **Which cookies count against the bound is decided here** (acceptance
 * criterion 4), and the login route acts on the answer rather than repeating
 * the rule. A cookie the browser holds is surplus when any of these is
 * true, and each is a decision:
 *
 * - Its record is gone or expired. The binding can never address anything
 *   again, so keeping it would spend a slot on nothing and cost the callback a
 *   store lookup. The store is asked, not the cookie's own age: `expiresAt` is
 *   the authoritative deadline and a browser cannot edit it — and asking it
 *   **reaps** a record already past that deadline, which is where a dead
 *   login's `nonce` and `verifier` used to be freed before this function stood
 *   between the callback and `consume` (peer review, TASK-272 r2, Important).
 * - Its name is not the one {@link browserBindingCookieName} gives its value.
 *   Only this origin can write a `__Host-` cookie, so a mismatch is this app's
 *   own older shape rather than an attack — but reading it would break the
 *   one-name-per-login pairing every clear below depends on.
 * - It repeats a binding already held under another name, for the same reason.
 * - It is older than the newest {@link MAX_BROWSER_BINDINGS}. Order comes from
 *   the store's `expiresAt` and never from the name: a name carrying a
 *   timestamp would be a second copy of a deadline the browser could edit, and
 *   distinct names carry no order of their own. Since every login gets the same
 *   TTL, expiry order is start order, which keeps the same rule the list shape
 *   had — a person who abandons tabs loses the oldest login rather than the one
 *   they are completing.
 *
 * **What the bound caps, exactly.** A callback never *consumes* against more
 * than {@link MAX_BROWSER_BINDINGS} bindings whatever the jar holds — that cap
 * is hard, and it is the one that matters, because consuming is the expensive
 * and security-bearing operation. It is **not** a cap on the deadline lookups
 * this function makes: those are one per distinct well-named cookie, bounded
 * only by what the browser sends, which is itself bounded by the user agent's
 * per-domain cookie cap. The clears that keep the jar small are emitted by
 * whichever answer runs next, so two logins starting at the same instant can
 * leave a browser holding one more than the bound until then. That transient is
 * the price of never blocking one login's write on another's, and the excess is
 * unreachable — the read side drops it — rather than merely untidy.
 */
export function selectBrowserBindings(
  store: OidcTransactionStore,
  held: readonly HeldBrowserBinding[],
  now: number,
): BrowserBindingSelection {
  const live: { entry: HeldBrowserBinding; expiresAt: number }[] = [];
  const surplus: HeldBrowserBinding[] = [];
  const seen = new Set<string>();

  for (const entry of held) {
    if (seen.has(entry.binding) || entry.cookieName !== browserBindingCookieName(entry.binding)) {
      surplus.push(entry);
      continue;
    }
    seen.add(entry.binding);
    const expiresAt = store.expiresAt(entry.binding);
    if (expiresAt === null || expiresAt <= now) {
      surplus.push(entry);
      continue;
    }
    live.push({ entry, expiresAt });
  }

  live.sort((left, right) => left.expiresAt - right.expiresAt);
  const overflow = Math.max(0, live.length - MAX_BROWSER_BINDINGS);
  for (const { entry } of live.slice(0, overflow)) surplus.push(entry);
  return { offered: live.slice(overflow).map(({ entry }) => entry), surplus };
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
 *
 * Both are rarer here than they read. Every binding
 * {@link selectBrowserBindings} offers has just been checked against
 * `expiresAt` and found live — and that check reaps what it finds dead — so on
 * the routes an expired binding is never offered; `expired` survives for a
 * record that dies between the two calls, and for a caller that offers bindings
 * this function never selected. That is not a claim that selection reaps every
 * dead record it could: a repeat or a misnamed cookie is surplus before
 * `expiresAt` is reached, so its record waits for `cleanupExpired` or the next
 * `save` (peer review, TASK-293 r1, Minor).
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
