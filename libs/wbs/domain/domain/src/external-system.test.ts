import { describe, expect, it } from 'bun:test';

import { EXTERNAL_SYSTEMS, refLabelOf, systemOfUrl } from './external-system';

describe('systemOfUrl', () => {
  it('types a GitHub pull request, and an issue on the same host differently', () => {
    // **The case the ordered list exists for.** `github.com` serves both from one
    // host, so a rule matching the host alone types every GitHub URL as whichever
    // arm comes first — and the two are different things a reader follows for
    // different reasons.
    //
    // Proof: the `github-pr` rule loosened to the host alone
    // (`hostIsOrEndsWith(url.hostname, 'github.com')`, dropping the `at[2]`
    // check), watched 2026-08-30 failing on the issue URL coming back
    // `github-pr` — a link to an issue drawn under the dot that says pull
    // request.
    expect(systemOfUrl('https://github.com/acme/shed/pull/42')).toBe('github-pr');
    expect(systemOfUrl('https://github.com/acme/shed/issues/42')).toBe('github-issue');
  });

  it('leaves a GitHub repository URL to the reader, because it is neither', () => {
    // Not a failure to recognise GitHub — a deliberate `null`. The row links to a
    // repository, which is not a PR and not an issue, and typing it as either
    // would put it under a dot that lies about what following it does.
    expect(systemOfUrl('https://github.com/acme/shed')).toBeNull();
  });

  it('separates Confluence from Jira by path, because they share a host', () => {
    // `*.atlassian.net` serves both, so this is the GitHub case again with a
    // different pair. Getting it wrong is worse here than for GitHub, because
    // design D3 gives Jira and Confluence the same *hue* — they are told apart by
    // fill against ring — so a mistyped ref is a dot that differs from the right
    // one only by a channel the reader is least likely to read.
    expect(systemOfUrl('https://acme.atlassian.net/browse/SHED-1')).toBe('jira-issue');
    expect(systemOfUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Rewire')).toBe(
      'confluence-page',
    );
  });

  it('leaves an Atlassian URL that is neither to the reader', () => {
    expect(systemOfUrl('https://acme.atlassian.net/jira/software/projects/SHED')).toBeNull();
  });

  it('types a Slack message by host alone, because Slack has no second kind here', () => {
    expect(systemOfUrl('https://acme.slack.com/archives/C123/p1700000000000000')).toBe(
      'slack-message',
    );
  });

  it('matches a host suffix but not a host that merely ends with the letters', () => {
    // `notgithub.com` is somebody else's domain. Matching it would type a
    // stranger's URL as a GitHub PR — the shape of bug a bare `includes` gives.
    //
    // Proof: `hostIsOrEndsWith` reduced to `host.endsWith(suffix)`, watched
    // 2026-08-30 failing on `notgithub.com` coming back `github-pr`.
    expect(systemOfUrl('https://github.com/a/b/pull/1')).toBe('github-pr');
    expect(systemOfUrl('https://www.github.com/a/b/pull/1')).toBe('github-pr');
    expect(systemOfUrl('https://notgithub.com/a/b/pull/1')).toBeNull();
  });

  it('an unmatched URL is left to the reader', () => {
    expect(systemOfUrl('https://example.com/whatever')).toBeNull();
  });

  it('answers null for a string that is not a URL at all, rather than throwing', () => {
    // A pasted string is external data at a boundary. "I do not recognise this"
    // is a modeled answer the editor renders — the type becomes the reader's to
    // type — and a throw here would turn a typo into a 500.
    expect(systemOfUrl('not a url')).toBeNull();
    expect(systemOfUrl('')).toBeNull();
  });

  it('refuses a non-http scheme even when its host and path would match a rule', () => {
    // The renderer refuses to make a link of these, so typing one would put a
    // scheme nothing can follow behind a dot that says it is followable. Refused
    // here as well as there, because the two rules protect different things: this
    // one keeps the *stored* type honest, and the renderer keeps the `href` safe.
    //
    // **`ftp:` and `ws:`, not `javascript:`, and that is the whole point of this
    // case.** The first version of this test used
    // `javascript:alert(1)//github.com/a/b/pull/1` and was watched **passing**
    // with the protocol check deleted — a check that cannot fail. `javascript:`
    // is not a special scheme, so `new URL` parses no host from it at all
    // (`hostname` is `""`), no pattern could ever have claimed it, and the line
    // under test was never reached. `ftp:` and `ws:` *are* special schemes: they
    // parse `github.com` as the host and `/a/b/pull/1` as the path, so they
    // satisfy the GitHub rule completely and the protocol check is the only thing
    // standing between them and a `github-pr`.
    //
    // Proof: the protocol check deleted, watched 2026-08-30 failing on
    // `ftp://github.com/a/b/pull/1` coming back `"github-pr"` where `null` is
    // owed. With the `javascript:` case alone it passed — R5's own lesson, in the
    // change that was writing it down.
    expect(systemOfUrl('ftp://github.com/a/b/pull/1')).toBeNull();
    expect(systemOfUrl('ws://github.com/a/b/pull/1')).toBeNull();
    // Kept beside them, and no longer load-bearing: these are the schemes a
    // reader actually pastes by accident, and they answer `null` one line
    // earlier — for having no host rather than for the check above.
    expect(systemOfUrl('javascript:alert(1)//github.com/a/b/pull/1')).toBeNull();
    expect(systemOfUrl('file:///etc/passwd')).toBeNull();
  });

  it('every name it can answer is one the migration seeds', () => {
    // **The seed and this list are one fact.** A URL that derives a name
    // `external_system` does not hold is a paste that types itself and then fails
    // to store, and the failure would surface as a foreign key error on a write
    // rather than as anything a reader could act on.
    //
    // Asserted against the migration's own text rather than a second hardcoded
    // list here — a copy would drift with the thing it is checking and could not
    // fail.
    const migration = new URL(
      '../../../apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql',
      import.meta.url,
    ).pathname;
    const seeded = Bun.file(migration);
    return seeded.text().then((sql) => {
      const names = [...sql.matchAll(/\('sys-[a-z-]+', '([a-z-]+)'\)/g)].map((each) => each[1]);
      expect(names.length).toBeGreaterThan(0);
      expect([...names].sort()).toEqual([...EXTERNAL_SYSTEMS].sort());
    });
  });
});

describe('refLabelOf', () => {
  it('reads a Jira issue as its key', () => {
    // The half of Dany's `ticket key + summary` a URL actually carries. The
    // summary is the reader's to type; this is what stands in until they do.
    //
    // Proof: the `browse` arm removed — this failed on `expected
    // 'newsiteam.atlassian.net/WCN-3887' to be 'WCN-3887'`, falling through to
    // the host rule. Watched 2026-09-09.
    expect(refLabelOf('https://newsiteam.atlassian.net/browse/WCN-3887')).toBe('WCN-3887');
    // A query and a fragment are Jira's own furniture and say nothing about
    // which issue this is, so neither reaches the label.
    expect(refLabelOf('https://acme.atlassian.net/browse/AB-1?filter=x#comment')).toBe('AB-1');
  });

  it('reads a pull request and an issue as their number', () => {
    // `#4178` and not `4178`: the number alone reads as a count beside a name,
    // and `#` is how both GitHub and every person here writes one.
    //
    // Proof: the GitHub arm removed — this failed on `expected
    // 'github.com/4178' to be '#4178'`. Watched 2026-09-09.
    expect(refLabelOf('https://github.com/o/r/pull/4178')).toBe('#4178');
    expect(refLabelOf('https://github.com/o/r/issues/12')).toBe('#12');
  });

  it('reads a Confluence page as its title, however the title was encoded', () => {
    // Two Confluence generations spell one title two ways, and a card showing
    // `Cache+warm-up+plan` beside `Cache warm-up plan` reads as two pages.
    //
    // Proof: `readableSegment` reduced to the segment itself — this failed on
    // `expected 'Cache+warm-up+plan' to be 'Cache warm-up plan'`. Watched
    // 2026-09-09.
    expect(
      refLabelOf('https://acme.atlassian.net/wiki/spaces/ENG/pages/9911/Cache+warm-up+plan'),
    ).toBe('Cache warm-up plan');
    expect(
      refLabelOf('https://acme.atlassian.net/wiki/spaces/ENG/pages/9911/Cache%20warm-up%20plan'),
    ).toBe('Cache warm-up plan');
  });

  it('reads a wiki URL with no page in it as its host and last segment', () => {
    // A space's home is a `/wiki/` URL with no title in it. That is a URL with
    // nothing to read rather than one whose title this failed to find, so it
    // takes the general rule instead of an empty label.
    expect(refLabelOf('https://acme.atlassian.net/wiki/spaces/ENG/overview')).toBe(
      'acme.atlassian.net/overview',
    );
  });

  it('reads an unclaimed URL as its host and last segment', () => {
    // The host **and** the segment: two links into one unrecognised host are
    // two different addresses, and a label that says only the host for both
    // makes the card a list of one word repeated.
    //
    // Proof: the last segment dropped from the fallback — this failed on
    // `expected 'example.test' to be 'example.test/thing'`. Watched 2026-09-09.
    expect(refLabelOf('https://example.test/a/thing')).toBe('example.test/thing');
    // A host with no path at all has only the host to give.
    expect(refLabelOf('https://example.test/')).toBe('example.test');
  });

  it('hands back a URL it cannot parse', () => {
    // Total, because a stored ref may hold anything a reader typed — be-01
    // refuses an empty URL and nothing else — and a label is the last place in
    // this app that should be able to throw.
    //
    // Proof: the `catch` arm changed to rethrow, and this failed on
    // `TypeError: Invalid URL`. Watched 2026-09-09.
    expect(refLabelOf('WCN-3887')).toBe('WCN-3887');
    expect(refLabelOf('')).toBe('');
  });

  it('names a scheme the renderer will not follow rather than hiding it', () => {
    // `followableHref` is what stops a `javascript:` URL being a link, on every
    // surface. This is only the words beside it, and words that said nothing
    // would leave a reader unable to see what the refusal is about.
    //
    // Proof: the empty-host arm removed — this failed on `expected
    // '/alert(1)' to be 'javascript:alert(1)'`, the host rule reading a URL
    // that has no host and putting a bare `/` in front of the payload. Watched
    // 2026-09-09.
    expect(refLabelOf('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(refLabelOf('mailto:someone@example.test')).toBe('mailto:someone@example.test');
  });
});
