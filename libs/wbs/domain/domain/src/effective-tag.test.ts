import { describe, expect, it } from 'bun:test';

import { effectiveTagsOf, TagAncestryCycleError, type TagsLabelled } from './effective-tag';
import { effectiveTeamsOf } from './effective-team';

const row = (id: string, parentId: string | null, ...tagIds: string[]): TagsLabelled => ({
  id,
  parentId,
  tagIds,
});

/** `id@statedBy` per tag in force, which is the whole of what this walk answers. */
const said = (found: Map<string, readonly { tagId: string; fromId: string }[]>, id: string) =>
  found.get(id)?.map((each) => `${each.tagId}@${each.fromId}`);

describe('effectiveTagsOf', () => {
  it('reaches an untagged leaf from the parent above it', () => {
    const rows = [row('parent', null, 'regulatory'), row('leaf', 'parent')];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['regulatory@parent']);
    expect(said(found, 'parent')).toEqual(['regulatory@parent']);
  });

  it('inherits an ancestor’s whole set, not its first member', () => {
    // The team half of this fault moves dates, because the capacity adapter
    // spends slots in whatever set it is handed. The tag half cannot move a
    // date — nothing below `slicesOf` reads a tag — and it is still wrong in the
    // way that matters for a label: a filter on `tech-debt` would not find a row
    // the plan says is `tech-debt`, and the row would be reported as one kind of
    // thing when the plan said two.
    const rows = [row('parent', null, 'regulatory', 'tech-debt'), row('leaf', 'parent')];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['regulatory@parent', 'tech-debt@parent']);
  });

  it('keeps every ancestor’s tags when a row states one of its own', () => {
    // The 2026-08-29 report, in one assertion: 010 carries `Risk` and `Review`,
    // 010.1 inherits both, somebody adds `Ready` to 010.1 — and under override
    // the two inherited ones stopped being in force at all. A tag says what kind
    // of thing the work is, and a child of a risky parent is still risky, so
    // stating one adds a word rather than replacing the sentence.
    //
    // ADR 0008 supersedes the override half of Dany's 2026-08-13 Q4 answer, for
    // tags alone. `lets a leaf’s own set beat its parent’s` — the assertion this
    // one replaces — is still true of teams and of services, in their own files.
    //
    // Proof: the `for (const above of carried)` half of `accumulate` deleted —
    // the override this replaces — and this failed on
    // `expect(received).toEqual(expected)`, `Expected - 2 / Received + 0`, with
    // `"risk@parent"` and `"review@parent"` gone from `[ "ready@leaf" ]`.
    // Watched 2026-08-29.
    const rows = [row('parent', null, 'risk', 'review'), row('leaf', 'parent', 'ready')];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['ready@leaf', 'risk@parent', 'review@parent']);
  });

  it('accumulates every ancestor in the chain, not only the nearest', () => {
    // Override stopped at the first statement it met; a union cannot, and this
    // is the assertion that says so. A grandparent's word is as much in force on
    // the leaf as its parent's.
    //
    // Proof: the inherited half of `accumulate` deleted — the same injection the
    // case above names, because an override walk cannot tell "only the nearest"
    // from "none at all" — and this failed on `Expected - 2 / Received + 0`,
    // with `"q3@parent"` and `"tech-debt@grandparent"` gone from
    // `[ "urgent@leaf" ]`. Watched 2026-08-29.
    const rows = [
      row('grandparent', null, 'tech-debt'),
      row('parent', 'grandparent', 'q3'),
      row('leaf', 'parent', 'urgent'),
    ];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['urgent@leaf', 'q3@parent', 'tech-debt@grandparent']);
    expect(said(found, 'parent')).toEqual(['q3@parent', 'tech-debt@grandparent']);
  });

  it('a row restating an ancestor’s tag states it itself, once', () => {
    // Two rows saying `risk` is one tag in force, and the **nearer** statement
    // owns it: the ✕ in the Tags cell is decided on `fromId`, so a reader who
    // wrote `risk` on this row must be able to take it off this row. Drawn twice
    // it would be a cell describing the tree rather than the work.
    //
    // Proof: the `claimed` guard on `accumulate`'s inherited half deleted, and
    // this failed on `expect(received).toEqual(expected)`, `Expected - 0 /
    // Received + 1`, with `"risk@parent"` standing beside `"risk@leaf"`.
    // Watched 2026-08-29.
    const rows = [row('parent', null, 'risk'), row('leaf', 'parent', 'risk')];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['risk@leaf']);
  });

  it('reads an empty set as adding nothing, and no tag anywhere as absence', () => {
    // `[]` is a row that has said nothing, which under accumulation is simply a
    // row that added no word: it carries what is above it, exactly as it did
    // under override. What changed is only the non-empty case. A plan with
    // nothing above a row leaves it absent from the map — one spelling of "no
    // tags at all", which is the call the export has carried since it was
    // written: an empty cell means nobody typed it.
    const carries = effectiveTagsOf([row('parent', null, 'regulatory'), row('leaf', 'parent')]);
    expect(said(carries, 'leaf')).toEqual(['regulatory@parent']);

    const nothing = effectiveTagsOf([row('parent', null), row('leaf', 'parent')]);
    expect(nothing.size).toBe(0);
  });

  it('names the row each tag came from, so a reader can be told', () => {
    // The `fromId` half of the reading, and what the Tags cell's inherited chip
    // renders: "Risk — inherited from 010 Compliance" cannot be said without it,
    // and a consumer showing an inherited tag would be showing an unexplained
    // one. **Per tag** and not per row, which is what accumulation cost: `leaf`
    // below carries two tags from two different rows in one cell.
    //
    // Proof: `accumulate`'s `push(above)` replaced by `push({ tagId:
    // above.tagId, fromId: statedBy })` and this failed on
    // `- "far@far-up" / + "far@near-up"` — a tag claiming to have been written
    // where it is drawn, which is a ✕ on a chip that cannot remove it.
    // Watched 2026-08-29.
    const rows = [
      row('far-up', null, 'far'),
      row('mid', 'far-up'),
      row('near-up', 'mid', 'near'),
      row('leaf', 'near-up'),
    ];

    const found = effectiveTagsOf(rows);

    expect(said(found, 'leaf')).toEqual(['near@near-up', 'far@far-up']);
  });

  it('resolves a chain of untagged rows once, and hands each of them the same answer', () => {
    // The memoisation, asserted the only way it is observable from outside:
    // every row the deepest walk passed through holds **the same object**, which
    // a per-row re-walk cannot produce. It survives the fork away from
    // `effectiveLabelsOf` because `accumulate` returns what it was handed when a
    // row states nothing — see its `Proof:`.
    //
    // The order of `rows` is load-bearing — deepest first, so `d`'s walk is the
    // one that reaches the tag.
    const rows = [row('d', 'c'), row('c', 'b'), row('b', 'a'), row('a', null, 'regulatory')];

    const found = effectiveTagsOf(rows);

    const answer = found.get('d');
    expect(answer).toBeDefined();
    for (const id of ['b', 'c']) expect(found.get(id)).toBe(answer);
  });

  it('refuses a parent chain that runs in a circle', () => {
    // R5. A cycle has no top, so there is no finite set of ancestors to
    // accumulate, and without the guard the walk does not come back at all —
    // which is why the assertion is on the throw and the injected fault is
    // watched as a hang. The error is the tag dimension's own, not the team
    // one's: a reader handed a `TeamAncestryCycleError` while filtering by tag
    // would go looking in the wrong half of the model.
    const rows = [row('a', 'b'), row('b', 'a')];

    expect(() => effectiveTagsOf(rows)).toThrow(TagAncestryCycleError);
  });

  it('refuses a circle above a row that is itself outside it', () => {
    // The cycle a leaf only reaches by climbing. Accumulation has to walk the
    // **whole** chain before it can answer for `leaf`, so there is no arm here
    // that could answer from the row's own tags and never notice the loop.
    const rows = [row('a', 'b', 'x'), row('b', 'a'), row('leaf', 'a', 'own')];

    expect(() => effectiveTagsOf(rows)).toThrow(TagAncestryCycleError);
  });

  it('answers for a row whose parent is not in the list', () => {
    // A parent from another project, or one that has been removed: the walk runs
    // out of rows rather than throwing, and the row carries only its own tags.
    expect(effectiveTagsOf([row('orphan', 'elsewhere')]).size).toBe(0);
    expect(said(effectiveTagsOf([row('orphan', 'elsewhere', 'own')]), 'orphan')).toEqual([
      'own@orphan',
    ]);
  });
});

describe('the two dimensions, read together', () => {
  /** A row that answers both questions at once, which every real row does. */
  const both = (
    id: string,
    parentId: string | null,
    teamIds: readonly string[],
    tagIds: readonly string[],
  ) => ({ id, parentId, teamIds, tagIds });

  it('overrides the team while accumulating the tags, and the mirror case', () => {
    // The property the whole design rests on, and the one a reader is most
    // likely to doubt: inheritance is **per dimension, independently** — and
    // since ADR 0008 the two dimensions no longer even inherit by the same rule.
    // A row that states tags keeps its ancestor's tags **and** its ancestor's
    // teams; a row that states teams keeps its ancestor's tags and loses its
    // ancestor's teams. Neither statement touches the other dimension, because
    // they are two walks over two fields.
    //
    // Proof: `effectiveTagsOf` pointed at `row.teamIds` and this fails with the
    // tag half reading `platform` — a plan whose filter facet lists teams under
    // the tag heading. Watched 2026-08-19 and again 2026-08-29.
    const rows = [
      both('parent', null, ['platform'], ['regulatory']),
      both('tags-only', 'parent', [], ['tech-debt']),
      both('teams-only', 'parent', ['design'], []),
    ];

    const teams = effectiveTeamsOf(rows);
    const tags = effectiveTagsOf(rows);

    // States tags, inherits teams — and keeps the tag above it, which is the
    // half ADR 0008 changed.
    expect(said(tags, 'tags-only')).toEqual(['tech-debt@tags-only', 'regulatory@parent']);
    expect(teams.get('tags-only')).toEqual({ teamIds: ['platform'], fromId: 'parent' });

    // The mirror: states teams, and the team above it is gone.
    expect(teams.get('teams-only')).toEqual({ teamIds: ['design'], fromId: 'teams-only' });
    expect(said(tags, 'teams-only')).toEqual(['regulatory@parent']);
  });

  it('keeps a row out of one map while it is in the other', () => {
    // Absence is per dimension too. A plan that labels teams and nothing else
    // has an empty tag map, and every consumer reads that as "nobody has
    // labelled anything" rather than as a row missing from the plan.
    const rows = [both('parent', null, ['platform'], []), both('leaf', 'parent', [], [])];

    expect(effectiveTeamsOf(rows).size).toBe(2);
    expect(effectiveTagsOf(rows).size).toBe(0);
  });
});
