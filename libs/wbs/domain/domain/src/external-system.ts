/**
 * The canonical name of the system a URL points at, or `null` when no pattern
 * matches and the reader has to say.
 *
 * **Every name this can answer must exist in `external_system`.** The seed in
 * `20260830020000_add_external_ref/migration.sql` and this list are one fact:
 * a URL that derives a name the table does not hold would be a paste that
 * types itself and then fails to store. `external-system.test.ts` asserts the
 * two agree rather than leaving it to be discovered.
 */
export const EXTERNAL_SYSTEMS = [
  'jira-issue',
  'github-pr',
  'github-issue',
  'confluence-page',
  'slack-message',
] as const;

export type ExternalSystemName = (typeof EXTERNAL_SYSTEMS)[number];

/**
 * One host+path rule. Ordered, and the order is load-bearing — see
 * {@link systemOfUrl}.
 */
interface SystemPattern {
  readonly name: ExternalSystemName;
  /** True when this rule claims the URL. Reads the parsed URL, never the string. */
  readonly claims: (url: URL) => boolean;
}

/** `example.atlassian.net` and `atlassian.net` both match; `notatlassian.net` does not. */
const hostIsOrEndsWith = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

/** The path split on `/` with the empty leading and trailing segments dropped. */
const segmentsOf = (url: URL): readonly string[] => url.pathname.split('/').filter(Boolean);

/**
 * The ordered rules.
 *
 * **GitHub's two rules are separated by path and not by host**, and that
 * separation is the whole reason this list is ordered rather than a host map:
 * `github.com` serves pull requests and issues from the same host, and a rule
 * matching the host alone would type every GitHub URL as whichever arm came
 * first. A repository URL with neither segment matches neither rule and is left
 * to the reader, which is correct — it is a link to a repository, not to a PR.
 *
 * Confluence and Jira share `*.atlassian.net`, so they are separated the same
 * way: `/wiki/` is Confluence, `/browse/` is a Jira issue. An Atlassian URL that
 * is neither is left to the reader rather than guessed at.
 */
const PATTERNS: readonly SystemPattern[] = [
  {
    name: 'github-pr',
    claims: (url) => {
      const at = segmentsOf(url);
      return hostIsOrEndsWith(url.hostname, 'github.com') && at[2] === 'pull';
    },
  },
  {
    name: 'github-issue',
    claims: (url) => {
      const at = segmentsOf(url);
      return hostIsOrEndsWith(url.hostname, 'github.com') && at[2] === 'issues';
    },
  },
  {
    name: 'confluence-page',
    claims: (url) =>
      hostIsOrEndsWith(url.hostname, 'atlassian.net') && segmentsOf(url)[0] === 'wiki',
  },
  {
    name: 'jira-issue',
    claims: (url) =>
      hostIsOrEndsWith(url.hostname, 'atlassian.net') && segmentsOf(url)[0] === 'browse',
  },
  {
    name: 'slack-message',
    claims: (url) => hostIsOrEndsWith(url.hostname, 'slack.com'),
  },
];

/**
 * Which system a URL belongs to, or `null` for one no rule claims.
 *
 * **Runs at the write and its answer is stored** (design D1). Nothing derives on
 * read, and that is the change's one irreversible-by-accident rule: this list
 * will grow, and re-deriving on read would silently re-type every existing ref —
 * including ones a reader had corrected by hand — with no record that it had
 * happened. The stored value is what a reader sees, and an override is simply
 * that value differing from what this function would say today.
 *
 * A URL this cannot parse answers `null` rather than throwing. That is not a
 * softened invariant: a pasted string is external data at a boundary, "I do not
 * recognise this" is a modeled answer the editor already renders (the type
 * becomes the reader's to type), and a throw here would turn a typo into a 500.
 * The write path still refuses a ref with **no** system, which is where the
 * unknown is actually not OK.
 *
 * @returns the canonical name, or `null` for an unrecognised or unparseable URL.
 */
export function systemOfUrl(url: string): ExternalSystemName | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only http(s) is claimed. A `javascript:` or `data:` URL is never a link to a
  // system, and typing one would put a scheme the renderer refuses behind a dot
  // that says it is followable.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return PATTERNS.find((pattern) => pattern.claims(parsed))?.name ?? null;
}

/**
 * The path segment a Confluence page's title is written in, given its segments.
 *
 * Confluence's own shape is `/wiki/spaces/<key>/pages/<id>/<Title+Words>`, so
 * the title is whatever follows the page id. `undefined` for a `/wiki/` URL of
 * any other shape — a space's home, a search — which is a URL with no title in
 * it rather than one whose title this failed to find.
 */
const confluenceTitleSegment = (segments: readonly string[]): string | undefined => {
  const pages = segments.indexOf('pages');
  return pages === -1 ? undefined : segments.at(pages + 2);
};

/**
 * A URL's own words, spelled the way a reader wrote them into it.
 *
 * `Some+Page+Title` and `Some%20Page%20Title` are the same title typed by two
 * Confluence versions, so both become `Some Page Title`. A segment that is not
 * valid percent-encoding is handed back as it stands: `decodeURIComponent`
 * throws on a lone `%`, and a label is not a place to fail.
 */
const readableSegment = (segment: string): string => {
  const spaced = segment.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
};

/**
 * What a link calls itself, read out of its URL — the label shown where a ref
 * has been given no name.
 *
 * **A fallback, never a stored value.** A ref's name is typed by a reader and
 * stored as typed (`work_item_external_ref.name`); this is what the card and the
 * editor draw in a name's place, computed at render, so a rule added here shows
 * up on every unnamed ref at once and changes no stored row. That is the
 * opposite of {@link systemOfUrl}'s bargain, and deliberately: a derived
 * _system_ is a value a reader may override and so has to be frozen at the
 * write, while a derived _label_ is only ever what is shown when there is
 * nothing to show instead.
 *
 * Dany, 2026-09-09: *"every link must have a name — for jira tickets it can be
 * ticket key + summary for example, for PRs it can be PR# + title"*. The summary
 * and the title are the reader's half — nothing here fetches anything — so this
 * answers the half a URL does carry: the key, and the number.
 *
 * **Total.** Every URL has a label, including one that will not parse: the
 * string itself. A ref with an unparseable URL is a real stored state (be-01
 * refuses an empty URL and nothing else), and a label is the last place that
 * should be able to throw.
 *
 * @param url the ref's URL, as stored.
 * @returns `WCN-3887` for a Jira issue, `#4178` for a GitHub pull request or
 * issue, a Confluence page's title, and otherwise the host with the last path
 * segment beside it — `example.test/thing` — or the whole string for a URL that
 * does not parse.
 */
export function refLabelOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // A scheme with no authority — `javascript:`, `mailto:`, `data:` — parses
  // fine and has no host, so the rules below have nothing to read. Its own
  // string is the only honest label, and it is the one a reader needs: this is
  // the URL {@link followableHref} refuses to make a link, and a label that hid
  // it would leave them unable to see what the refusal is about.
  if (parsed.hostname === '') return url;
  const segments = segmentsOf(parsed);
  // `.at()` rather than `[]` throughout, because this file's tsconfig does not
  // set `noUncheckedIndexedAccess`: an index read is typed `string` however
  // short the array is, so `segments[3] !== undefined` is a condition ESLint
  // correctly calls impossible and a URL of `/o/r/pull` would return `#undefined`.
  const kind = segments.at(2);
  if (hostIsOrEndsWith(parsed.hostname, 'github.com') && (kind === 'pull' || kind === 'issues')) {
    const number = segments.at(3);
    if (number !== undefined) return `#${number}`;
  }
  if (hostIsOrEndsWith(parsed.hostname, 'atlassian.net')) {
    const area = segments.at(0);
    if (area === 'browse') {
      const key = segments.at(1);
      if (key !== undefined) return key;
    }
    if (area === 'wiki') {
      const title = confluenceTitleSegment(segments);
      if (title !== undefined) return readableSegment(title);
    }
  }
  // The host, and the last segment beside it where there is one: two links into
  // one unrecognised host are two different addresses, and a label that says
  // only `example.test` for both makes the card a list of one word repeated.
  const last = segments.at(-1);
  return last === undefined ? parsed.hostname : `${parsed.hostname}/${readableSegment(last)}`;
}
