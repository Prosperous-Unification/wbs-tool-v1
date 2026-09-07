<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks".

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The table stops being locked inside planToMarkdown

- [x] 1.1 `plan-export.ts`: `planToMarkdown` splits into two exported pieces —
      `markdownHeaderLines(plan, extra?)` (the bold `**key:** value` lines,
      with room for a caller's own extra fields after the ones it always
      carries) and `markdownTableLines(plan)` (the table alone). `planToMarkdown`
      itself becomes the two joined, unchanged output. Test: `markdownHeaderLines
and markdownTableLines join back into exactly what planToMarkdown writes,
with no extra fields` — a guard against the split drifting from the
      function it used to be.
- [x] 1.2 `extra` fields append after the ones `planToMarkdown` always carries.
      Test: `appends extra header fields after the ones planToMarkdown always
carries`.

## 2. The bundle

- [x] 2.1 `planToMermaidDocument` (`plan-mermaid.ts`) calls `planToMermaid`,
      returns its refusal verbatim if it has one, and otherwise joins the
      header block (with the new `Scope` field), the fence, and
      `markdownTableLines`. Tests: `bundles the header, the fence and the
table, in that order`, `embeds the same table planToMarkdown writes for
the same plan`.
- [x] 2.2 The `Scope` field states the document is the whole plan, not what is
      on screen. Test: `says in its header that the document is the whole
plan, not what is on screen`.
- [x] 2.3 The refusals pass through unchanged. Tests: `refuses exactly where the
diagram refuses, and says the same sentence`, `puts no document in a
refusal, so a download cannot save one`.

## 3. The one new guard, watched red

- [x] 3.1 **The fence widens past the longest run of backticks in the diagram.**
      A plain triple-backtick fence around a diagram whose task text contains
      ` ``` ` (from a work item name — free text, nothing in the gantt
      grammar escapes a backtick) would close early and spill the rest of the
      document, including the whole table, out as prose. Guard test: `widens
the fence past a backtick run in a task name, so the name cannot close it
early`. Negative test: the fence hard-coded back to ` ``` ` — verify.md
      fault 1.

## 4. planFileName

- [x] 4.1 `extension` argument, defaulting to `csv` so every existing caller
      compiles unchanged. Tests: `defaults to csv when no extension is asked
for, so every existing caller is unchanged`, `names the bundled Mermaid
document md instead, on the same date and slug`.

## 5. The record

- [x] 5.1 `proposal.md`, this file, the delta spec, `verify.md`. **No
      `design.md`**, no citation table: PoC-mode contract, 2026-08-14.
- [x] 5.2 **Not done here: the Download as Markdown document button.**
      **Closed 2026-08-29 without work:** wire-export-buttons 1.1/2.1 built `copyAsMermaid` and `downloadMermaidDocument`; both controls are in `wbs-table.tsx`.
      `wbs-table.tsx` is another agent's file tonight, the same constraint M1
      shipped under. Left unticked deliberately — M2 is not reachable from the
      app until it lands. The patch is not drafted in `verify.md` this time
      (M1's already covers the import and the toast pattern this handler
      reuses); the one new piece is a `Blob`-and-anchor download, the same
      shape `downloadCsv` already has (`wbs-table.tsx:2696-2705`).
