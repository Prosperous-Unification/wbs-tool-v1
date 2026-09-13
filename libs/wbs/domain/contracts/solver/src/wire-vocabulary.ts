/**
 * The repository check behind 2.1's "prose is descriptive only" claim.
 *
 * Three rounds running, an obsolete prose schema in one of the descriptive
 * artifacts was an implementation instruction contradicting the real one. 2.1
 * settled the remedy as **set equality, not a ban on prose**: a planning
 * artifact that may not name a field cannot say what the schema must contain,
 * and the earlier "no field list outside the schema" wording rejected design.md,
 * spec.md and tasks.md on the round it was written.
 *
 * Run 20 left this as a prototype run once at `af05ead1` and never re-run —
 * a statement about that head and not about any other. This module is that
 * prototype turned into a check that runs at every head, with the negative
 * fixture 2.1 names carried as a test rather than as a promise.
 *
 * ## Coverage, stated on a pass as well as a failure
 *
 * 2.1 names **four** descriptive artifacts. Three are in this repository and
 * this check covers them. The fourth — the long-form note — lives in the Claire
 * workspace as `notes/wbs-dual-optimized-scheduler-design.md` and was
 * deliberately not copied in (2.1, decided run 3): its §6 is a review ledger,
 * and a second copy would be either synced (two sources of truth for a ledger)
 * or frozen (a check enforcing against a stale artifact). So `UNCOVERED_ARTIFACT`
 * is printed by the check's own reporter every time, so that "3 of 4" is never
 * read as "4 of 4".
 *
 * ## Two refinements to 2.1's definitions, both measured rather than assumed
 *
 * 2.1 defines an enumeration as "a maximal run of three or more backticked
 * identifiers joined only by commas, `and` or `/`". Read literally that
 * definition fails on the two artifacts it exists to check:
 *
 * 1. **It does not catch 2.1's own watched-red fixture.** The superseded
 *    sentence reads "carry its `sliceKey`, an integer `durationUnits`,
 *    `width`, …": the join between the first two identifiers is `, an integer `,
 *    which is not "only a comma", so the run breaks at length one and the
 *    sentence 2.1 requires the check to reject is not even an enumeration.
 *    A list in English prose carries modifiers between its members; the
 *    connector rule here is therefore that the gap **contains** a comma, an
 *    `and` or a `/`, carries no sentence terminator and no other code span, and
 *    is short (`MAX_CONNECTOR_CHARS`).
 * 2. **It is blind to the brace form both design.md and spec.md actually use.**
 *    `` `{ wireVersion, contractVersion, … }` `` is one backticked token, not a
 *    run of them, and it is the form the schema's own `$comment` uses. A single
 *    code span whose content is a brace/bracket/paren-delimited comma-separated
 *    list of identifiers is therefore an enumeration of its members.
 *
 * Both refinements widen the check. Neither weakens it: every enumeration the
 * literal definition finds is still an enumeration here.
 *
 * ## Rule (b) does not gate the artifacts yet, and the reason is a measurement
 *
 * Rule (a) is exact: a tag names a set, so equality is decidable and any drift
 * is unambiguous — it is the shipped gate over the three covered artifacts, and
 * it is the rule that catches the defect 2.1 was actually written for, an
 * obsolete prose schema contradicting the real one three rounds running.
 *
 * Rule (b) is an attribution heuristic, and run as a gate over untagged prose at
 * `6ab005fa` it reported **seventeen** divergences of which **none** was drift.
 * Run 22 read that as one debt — six tuples 2.1's list of eight does not name —
 * and run 23 paid the part of it that naming can pay. Seven vocabularies were
 * added, every one read out of the artifact that defines it: `objectiveValues`
 * and the two `status` enums parsed from the schema, and `domain-slice`,
 * `canonical-row`, `fencing` and `objective-term-name` as literals carrying
 * their source (see `NEIGHBOUR_VOCABULARIES`).
 *
 * **Measured at that head, naming took 17 to 12** — five sentences closed: the
 * domain slice tuple in tasks.md, the two hashed-`PlannedRow` sentences in
 * design.md and spec.md, and both spawn-fencing sentences.
 *
 * **The remaining twelve are one finding, and it is not a missing name.** Every
 * one is a run that mixes two vocabularies **both of which are now named** — the
 * objective-term *fields* beside the term *names* (3), the response fields beside
 * response `status` *values* (2), the cache columns beside a cache `status` value
 * or a decoder function (2), the plan-read block's own name beside its ten
 * members (1), `PARALLEL` and `publication` beside tuples they qualify (2), the
 * canonical-input *fact* list beside the slice fields it contains (1), and 3b.1's
 * project-settings columns, still genuinely unnamed (1). Rule (b) as 2.1 writes
 * it — "a run mixing two vocabularies or naming a non-member is not [legal]" —
 * rejects a mixed run *by construction*, so naming the second vocabulary cannot
 * close one: `attribute` picks a single winner by overlap and every other member
 * is unexpected against it, whatever set it belongs to. Adding names moved the
 * count only where the sentence was drawn from ONE tuple all along.
 *
 * So the artifact scan still passes `['a']`, and what stands between rule (b)
 * and the gate is now a decision in 2.1 rather than work in the slices: either
 * the twelve sentences are rewritten so no run spans two tuples, or rule (b)'s
 * subset test is taken against the **union** of the vocabularies a run overlaps.
 *
 * ## The union reading is implemented and measured — and it is not enough
 *
 * `SubsetMode` carries both readings so the choice is made on numbers. Measured
 * at this head: `'best'` reports **12**, `'union'` reports **9**. Neither is
 * zero, so the union alone does not let rule (b) gate; it is an improvement to
 * be adopted or refused on its own merits, not a way out of the twelve.
 *
 * **Its first form was refuted by 2.1's own falsifier and the falsifier is now a
 * test.** Admitting any member of any named vocabulary passed
 * `` `wireVersion`, `status`, `offsets` and `resultJson` `` — a response
 * enumeration carrying a *cache* column, which is exactly the drift rule (b)
 * exists to catch. `cache-key` cleared a bare two-name overlap only because it
 * carries `status` **and the drifting name itself**. So admission excludes the
 * member being judged: a vocabulary admits `m` only when it contributes
 * `MIN_OVERLAP` names *besides* `m`. Under that form the falsifier is caught in
 * both modes and 2.1's watched red still reds on `sliceKey`, which belongs to no
 * named tuple at all.
 *
 * **And that form had a second defect, which the counts could not show (run
 * 24).** Admission ran *only* through the overlap bar, so the attributed
 * vocabulary had no standing of its own: a run whose winner overlapped by
 * exactly two reported both of those names as unexpected — names `'best'`
 * admits by definition. `'union'` was therefore not the weaker reading 2.1
 * adopted it for; it was weaker on *sentences* and stricter on *names*.
 * Measured at `a7446cd2`, tasks.md 149 read `PARALLEL` under `'best'` and
 * `PARALLEL, poolIds, width` under `'union'`. Admission now starts from the
 * attributed vocabulary and the overlap bar only *adds* to it, which leaves
 * both counts where they were and makes the union a genuine superset. The
 * property is asserted per sentence, because a total cannot see it.
 *
 * The counts above are the ratchet either way and both are asserted.
 */

export type VocabularyName =
  | 'request'
  | 'response'
  | 'slice'
  | 'objective-term'
  | 'objective-values'
  | 'response-status'
  | 'objective-term-status'
  | 'cache-key'
  | 'plan-read-optimization'
  | 'optimization-generation'
  | 'solver-queue'
  | 'domain-slice'
  | 'canonical-row'
  | 'fencing'
  | 'objective-term-name';

export interface Vocabulary {
  readonly name: VocabularyName;
  readonly members: ReadonlySet<string>;
  /** Where the tuple is defined — a schema pointer, or the tasks.md item. */
  readonly source: string;
}

/**
 * The one artifact this check cannot reach, named in its own output.
 *
 * @see UNCOVERED_ARTIFACT_REASON
 */
export const UNCOVERED_ARTIFACT =
  'notes/wbs-dual-optimized-scheduler-design.md — the long-form design note, which lives in the Claire workspace and has no copy in this repository';

export const UNCOVERED_ARTIFACT_REASON =
  '2.1, decided run 3: its §6 is a review ledger, so a copy here would be either synced (two sources of truth for a ledger) or frozen (a check enforcing a stale artifact). Whoever amends the wire amends the note in the same chunk.';

/** The three descriptive artifacts this check does cover, repo-relative. */
export const COVERED_ARTIFACTS = [
  'openspec/changes/dual-optimized-scheduler/tasks.md',
  'openspec/changes/dual-optimized-scheduler/design.md',
  'openspec/changes/dual-optimized-scheduler/specs/scheduler-optimization/spec.md',
] as const;

/**
 * Rule (c): the stored shapes have their own authority in the codec requirement
 * (4.12b) and are excluded by name, so an enumeration of a stored tuple is never
 * misattributed to the wire.
 */
export const EXCLUDED_SHAPES: readonly string[] = ['OptimizedResult', 'StoredObjectiveValue'];

/** Longest gap between two members before a run stops being one list. */
export const MAX_CONNECTOR_CHARS = 96;

/**
 * How many members a vocabulary must contribute before rule (b) will consider a
 * run to be drawing on it. It is 2 in both readings, and it is the same number
 * twice for one reason: a single shared name is a coincidence between tuples,
 * not evidence that the sentence is about both.
 *
 * Under `'union'` this is load-bearing rather than tidy. See `SubsetMode`.
 */
export const MIN_OVERLAP = 2;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface CodeSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The four wire sets, parsed from the schema rather than restated here — the
 * whole point of 2.1 is that the schema is the only definition.
 *
 * `response` is the **union** of every `required` array under `$defs/response`.
 * The base object requires `wireVersion` and `status`; the conditional `then`
 * adds `offsets` and `objectiveValues`; the `else` branch's `not/anyOf` names
 * those same two as prohibited. Taking the union is only safe while the
 * prohibited names are a subset of the required ones — otherwise a prohibition
 * would enter the vocabulary as if it were a member — so
 * `wireVocabularies` asserts that coincidence instead of relying on it.
 */
export function wireVocabularies(schema: unknown): Map<VocabularyName, Vocabulary> {
  const defs = (schema as { $defs?: Record<string, unknown> }).$defs;
  if (!defs) throw new Error('solver-wire.v1.json has no $defs');

  const requiredAt = (name: string): string[] => {
    const node = defs[name] as { required?: unknown } | undefined;
    if (!node) throw new Error(`solver-wire.v1.json has no $defs/${name}`);
    const required = node.required;
    if (!Array.isArray(required)) throw new Error(`$defs/${name} has no required array`);
    return required as string[];
  };

  const enumAt = (name: string, property: string): string[] => {
    const node = defs[name] as { properties?: Record<string, unknown> } | undefined;
    if (!node) throw new Error(`solver-wire.v1.json has no $defs/${name}`);
    const member = node.properties?.[property] as { enum?: unknown } | undefined;
    const values = member?.enum;
    if (!Array.isArray(values))
      throw new Error(`$defs/${name}/properties/${property} has no enum array`);
    return values as string[];
  };

  const responseUnion = new Set<string>();
  const prohibited = new Set<string>();
  collectRequired(defs['response'], responseUnion, prohibited, false);
  for (const name of prohibited) {
    if (!responseUnion.has(name)) {
      throw new Error(
        `$defs/response prohibits '${name}' without ever requiring it, so the response ` +
          'vocabulary can no longer be read as the union of its required arrays',
      );
    }
  }

  const entries: readonly Vocabulary[] = [
    {
      name: 'request',
      members: new Set(requiredAt('request')),
      source: 'solver-wire.v1.json#/$defs/request/required',
    },
    {
      name: 'response',
      members: responseUnion,
      source: 'solver-wire.v1.json#/$defs/response — union of every required array',
    },
    {
      name: 'slice',
      members: new Set(requiredAt('slice')),
      source: 'solver-wire.v1.json#/$defs/slice/required',
    },
    {
      name: 'objective-term',
      members: new Set(requiredAt('objective-term')),
      source: 'solver-wire.v1.json#/$defs/objective-term/required',
    },
    {
      name: 'objective-values',
      members: new Set(requiredAt('objectiveValues')),
      source: 'solver-wire.v1.json#/$defs/objectiveValues/required',
    },
    {
      name: 'response-status',
      members: new Set(enumAt('response', 'status')),
      source: 'solver-wire.v1.json#/$defs/response/properties/status/enum',
    },
    {
      name: 'objective-term-status',
      members: new Set(enumAt('objective-term', 'status')),
      source: 'solver-wire.v1.json#/$defs/objective-term/properties/status/enum',
    },
  ];

  return new Map(entries.map((v) => [v.name, v]));
}

function collectRequired(
  node: unknown,
  required: Set<string>,
  prohibited: Set<string>,
  underNot: boolean,
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRequired(child, required, prohibited, underNot);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'required' && Array.isArray(value)) {
      for (const name of value as string[]) (underNot ? prohibited : required).add(name);
      continue;
    }
    collectRequired(value, required, prohibited, underNot || key === 'not');
  }
}

/**
 * The four vocabularies this change defines that have no schema yet — there is
 * no cache table, no generation row and no plan-read DTO in the repository, so
 * these are literals carrying the tasks.md item that defines them.
 *
 * They exist so that rule (b) can attribute a table enumeration to the table it
 * describes. Without them every `projectId, inputHash, objective` run overlaps
 * the wire sets on `objective` alone and a check that does not know its own
 * vocabularies misattributes every table tuple to the wire.
 */
export const TABLE_VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'cache-key',
    members: new Set([
      'projectId',
      'inputHash',
      'objective',
      'contractVersion',
      'budgetMs',
      'generation',
      'status',
      'resultJson',
      'failureReason',
      'createdAt',
    ]),
    source: 'tasks.md 3.1 — optimized_schedule_cache, composite PK and columns',
  },
  {
    name: 'optimization-generation',
    members: new Set([
      'projectId',
      'contractVersion',
      'generation',
      'inputHash',
      'cancelEpoch',
      'admissionState',
      'updatedAt',
    ]),
    source: 'tasks.md 3.2 — optimization_generation, PK and columns',
  },
  {
    name: 'solver-queue',
    members: new Set([
      'projectId',
      'contractVersion',
      'objective',
      'budgetMs',
      'generation',
      'admittedCancelEpoch',
      'enqueuedAt',
    ]),
    source: 'tasks.md 3.2 — solver_queue, PK and columns',
  },
  {
    name: 'plan-read-optimization',
    members: new Set([
      'enabled',
      'engine',
      'objective',
      'inputHash',
      'generation',
      'contractVersion',
      'budgetMs',
      'displayed',
      'variants',
      'comparison',
    ]),
    source: 'tasks.md 7.10 — the plan-read optimization block',
  },
];

/**
 * The four tuples this change names outside the wire and outside a table, each
 * read out of the artifact that defines it rather than out of the sentence that
 * mentions it. That direction is the whole discipline: a vocabulary asserted
 * from memory is the same failure rule (b) exists to catch, in a new place.
 *
 * They exist because rule (b) attributes by overlap, and an unnamed tuple is
 * attributed to whichever named one it happens to share names with — the domain
 * slice to the *wire* slice (they share `personId`, `width`, `poolIds`), the
 * spawn fencing triple to `optimization_generation`. Four sentences and two
 * sentences respectively were reported as divergences on that account at
 * `6ab005fa` and not one of them was drift.
 */
export const NEIGHBOUR_VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'domain-slice',
    members: new Set(['workItemId', 'stepId', 'days', 'personId', 'width', 'poolIds']),
    source:
      "libs/domain/src/schedule.ts:31 — `interface Slice`, the domain input tuple, which is NOT the wire slice: the wire's `key` folds the first two, and `durationUnits`, `priorityWeight`, `notBeforeUnits`, `deadlineUnits` and `workItemIsMilestone` are derived rather than carried in",
  },
  {
    name: 'canonical-row',
    members: new Set(['id', 'parentId', 'position', 'frozenNumber', 'priority']),
    source:
      'libs/domain/src/canonical-schedule-input.ts:184-188 — the hashed `PlannedRow` facts, as the canonicalizer projects them',
  },
  {
    name: 'fencing',
    members: new Set(['generation', 'cancelEpoch', 'attemptToken']),
    source:
      'design.md — "Every spawn carries `(generation, cancelEpoch, attemptToken)`"; the same triple governs the worker-owned outcome write in tasks.md 3.2 and 6.11',
  },
  {
    name: 'objective-term-name',
    members: new Set(['PRIORITY', 'MAKESPAN', 'MOVEMENT']),
    source:
      'design.md — "Objective mathematics": `MAKESPAN = max finish`, `MOVEMENT = Σ |start − baselineStart|`, `PRIORITY = Σ w(s)·finish(s)`. These are the mathematical term NAMES and deliberately not the wire keys, which solver-wire.v1.json#/$defs/objectiveValues fixes lowercase and whose own $comment says so',
  },
];

export function allVocabularies(schema: unknown): Map<VocabularyName, Vocabulary> {
  const all = wireVocabularies(schema);
  for (const v of TABLE_VOCABULARIES) all.set(v.name, v);
  for (const v of NEIGHBOUR_VOCABULARIES) all.set(v.name, v);
  return all;
}

export interface Enumeration {
  readonly file: string;
  readonly line: number;
  /** The set named by the enclosing `<!-- wire-fields:… -->` tag, if any. */
  readonly tag: string | null;
  readonly members: readonly string[];
  readonly excerpt: string;
}

export interface Divergence {
  readonly file: string;
  readonly line: number;
  readonly rule: 'a' | 'b' | 'tag';
  readonly vocabulary: string | null;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly message: string;
}

/**
 * A tag span whose set name is `fixture` marks a quoted negative example — text
 * an artifact carries **in order to** reject it. Without it 2.1's own watched
 * red would fail the check that 2.1 requires to reject it, which is not a
 * finding, it is the artifact quoting itself.
 */
export const FIXTURE_TAG = 'fixture';

const TAG = /<!--\s*wire-fields:([A-Za-z][A-Za-z0-9-]*)\s*-->/g;

interface TagSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Spans run from the tag to the end of its sentence or to the next tag,
 * whichever comes first (2.1). A tag written inside a code span is prose about
 * the syntax, not an instance of it.
 */
export function tagSpans(text: string): TagSpan[] {
  const codeSpans = inlineCodeSpans(text);
  const raw: { name: string; from: number }[] = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m !== null; m = TAG.exec(text)) {
    const at = m.index;
    if (codeSpans.some((c) => at >= c.start && at < c.end)) continue;
    raw.push({ name: m[1], from: at + m[0].length });
  }
  return raw.map((tag, i) => {
    const nextTag = raw[i + 1]?.from ?? text.length;
    return { name: tag.name, start: tag.from, end: Math.min(nextTag, sentenceEnd(text, tag.from)) };
  });
}

/**
 * A sentence ends at `.`, `!` or `?` followed by whitespace or end of text.
 * `§3.4` and `Number.MAX_SAFE_INTEGER` do not end one because their period is
 * followed by a non-space; a period inside a code span never ends one either.
 */
export function sentenceEnd(text: string, from: number): number {
  const codeSpans = inlineCodeSpans(text);
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    if (i + 1 < text.length && !/\s/.test(text[i + 1])) continue;
    if (codeSpans.some((c) => i >= c.start && i < c.end)) continue;
    return i + 1;
  }
  return text.length;
}

function inlineCodeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const re = /`([^`\n]+)`/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    spans.push({ text: m[1], start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * A gap joins two members of one list when it carries a comma, an `and` or a
 * `/`, no sentence terminator, no paragraph break, and is short. See the module
 * header for why "only by commas" is read as "containing a comma".
 */
function isConnector(gap: string): boolean {
  if (gap.length === 0 || gap.length > MAX_CONNECTOR_CHARS) return false;
  if (gap.includes('\n\n')) return false;
  if (gap.includes('<!--') || gap.includes('-->')) return false;
  if (/[.!?;:]\s/.test(gap) || /[.!?;:]$/.test(gap)) return false;
  return gap.includes(',') || gap.includes('/') || /\band\b/.test(gap);
}

/** `{ a, b, c }` in one code span is a list of its members. */
function bracedMembers(code: string): string[] | null {
  const m = /^[{[(]\s*([^{}[\]()]+?)\s*[)\]}]$/.exec(code.trim());
  if (!m) return null;
  const parts = m[1].split(',').map((p) => p.trim());
  if (parts.length < 3) return null;
  return parts.every((p) => IDENTIFIER.test(p)) ? parts : null;
}

/**
 * Every enumeration in one artifact: maximal runs of three or more identifier
 * code spans joined by connectors, plus every braced list of three or more.
 */
export function scanEnumerations(text: string, file: string): Enumeration[] {
  const spans = inlineCodeSpans(text);
  const tags = tagSpans(text);
  const tagAt = (at: number): string | null =>
    tags.find((t) => at >= t.start && at < t.end)?.name ?? null;
  const lineAt = (at: number): number => text.slice(0, at).split('\n').length;

  const found: Enumeration[] = [];
  const emit = (members: string[], at: number, excerpt: string): void => {
    const tag = tagAt(at);
    if (tag === FIXTURE_TAG) return;
    if (members.some((m) => EXCLUDED_SHAPES.includes(m))) return;
    found.push({ file, line: lineAt(at), tag, members, excerpt });
  };

  let run: CodeSpan[] = [];
  const flush = (): void => {
    if (run.length >= 3) {
      const first = run[0];
      const last = run[run.length - 1];
      emit(
        run.map((s) => s.text),
        first.start,
        text.slice(first.start, last.end),
      );
    }
    run = [];
  };

  for (const span of spans) {
    const braced = bracedMembers(span.text);
    if (braced) {
      flush();
      emit(braced, span.start, span.text);
      continue;
    }
    if (!IDENTIFIER.test(span.text)) {
      flush();
      continue;
    }
    if (run.length > 0 && !isConnector(text.slice(run[run.length - 1].end, span.start))) flush();
    run.push(span);
  }
  flush();

  return found;
}

/**
 * Rules (a) and (b) over one artifact.
 *
 * (a) a tagged enumeration equals its set exactly, reported with file, line and
 *     the symmetric difference; (b) an untagged one is attributed to the
 *     vocabulary it overlaps most and, when that overlap is two or more, must be
 *     a subset of it. A tag naming no known vocabulary is itself a failure —
 *     otherwise a typo silently disables rule (a) for that span.
 */
export type SubsetMode = 'best' | 'union';

export function checkArtifact(
  text: string,
  file: string,
  vocabularies: ReadonlyMap<VocabularyName, Vocabulary>,
  rules: readonly ('a' | 'b')[] = ['a', 'b'],
  subsetMode: SubsetMode = 'best',
): Divergence[] {
  const divergences: Divergence[] = [];
  const known = new Set<string>(vocabularies.keys());

  for (const tag of tagSpans(text)) {
    if (tag.name === FIXTURE_TAG || known.has(tag.name)) continue;
    divergences.push({
      file,
      line: text.slice(0, tag.start).split('\n').length,
      rule: 'tag',
      vocabulary: tag.name,
      missing: [],
      unexpected: [],
      message: `wire-fields tag names '${tag.name}', which is not one of ${[...known].sort().join(', ')}`,
    });
  }

  for (const found of scanEnumerations(text, file)) {
    const members = new Set(found.members);
    if (found.tag !== null) {
      if (!rules.includes('a')) continue;
      const vocabulary = vocabularies.get(found.tag as VocabularyName);
      if (!vocabulary) continue;
      const missing = [...vocabulary.members].filter((m) => !members.has(m)).sort();
      const unexpected = [...members].filter((m) => !vocabulary.members.has(m)).sort();
      if (missing.length === 0 && unexpected.length === 0) continue;
      divergences.push({
        file,
        line: found.line,
        rule: 'a',
        vocabulary: found.tag,
        missing,
        unexpected,
        message:
          `tagged '${found.tag}' (${vocabulary.source}) but the enumeration is not that set: ` +
          describeDifference(missing, unexpected),
      });
      continue;
    }

    if (!rules.includes('b')) continue;
    const best = attribute(members, vocabularies);
    if (!best || best.overlap < 2) continue;
    const admits = (member: string): boolean =>
      best.vocabulary.members.has(member) ||
      (subsetMode === 'union' &&
        [...vocabularies.values()].some(
          (v) => v.members.has(member) && overlapWith(members, v) - 1 >= MIN_OVERLAP,
        ));
    const unexpected = [...members].filter((m) => !admits(m)).sort();
    if (unexpected.length === 0) continue;
    divergences.push({
      file,
      line: found.line,
      rule: 'b',
      vocabulary: best.vocabulary.name,
      missing: [],
      unexpected,
      message:
        `untagged enumeration overlaps '${best.vocabulary.name}' (${best.vocabulary.source}) on ` +
        `${String(best.overlap)} of ${String(members.size)} names but is not a subset of it: names ${unexpected.join(', ')}`,
    });
  }

  return divergences;
}

function describeDifference(missing: readonly string[], unexpected: readonly string[]): string {
  const parts: string[] = [];
  if (unexpected.length > 0) parts.push(`names ${unexpected.join(', ')}`);
  if (missing.length > 0) parts.push(`omits ${missing.join(', ')}`);
  return parts.join('; ');
}

function attribute(
  members: ReadonlySet<string>,
  vocabularies: ReadonlyMap<VocabularyName, Vocabulary>,
): { vocabulary: Vocabulary; overlap: number } | null {
  let best: { vocabulary: Vocabulary; overlap: number } | null = null;
  for (const vocabulary of vocabularies.values()) {
    const overlap = overlapWith(members, vocabulary);
    if (overlap > (best?.overlap ?? 0)) best = { vocabulary, overlap };
  }
  return best;
}

function overlapWith(members: ReadonlySet<string>, vocabulary: Vocabulary): number {
  let overlap = 0;
  for (const member of members) if (vocabulary.members.has(member)) overlap += 1;
  return overlap;
}

/**
 * The reporter. It always names the artifact it could not read, on a pass as
 * well as on a failure, so that "3 of 4" is never read as "4 of 4".
 */
export function report(divergences: readonly Divergence[], covered: readonly string[]): string {
  const lines = [
    `wire-vocabulary: checked ${String(covered.length)} of 4 descriptive artifacts`,
    ...covered.map((f) => `  covered:   ${f}`),
    `  UNCOVERED: ${UNCOVERED_ARTIFACT}`,
    `             ${UNCOVERED_ARTIFACT_REASON}`,
  ];
  if (divergences.length === 0) {
    lines.push('  no divergent enumeration');
    return lines.join('\n');
  }
  for (const d of divergences) {
    lines.push(`  ${d.file}:${String(d.line)} [rule ${d.rule}] ${d.message}`);
  }
  return lines.join('\n');
}
