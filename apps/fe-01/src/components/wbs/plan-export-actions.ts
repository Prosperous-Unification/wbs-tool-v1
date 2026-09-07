import type { Row } from '@tanstack/react-table';
import { useCallback, useRef } from 'react';

import type { PersonView, PriorityBandView, ServiceView, TagView, TeamView } from '@/lib/wbs-api';
import { type StepView } from '@/lib/wbs-api';

import type { PlanTableFeatures } from './plan-columns/column';
import { type PlanExport, planFileName, planToCsv, planToMarkdown } from './plan-export';
import { planToMermaid, planToMermaidDocument } from './plan-mermaid';
import { type Toast } from './toasts';
import { type FilterCriteria, type FilterLabels, filterWords } from './tree-search';
import type { ChartRead } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/** Coordinates the table’s plan export actions state and actions. */
export function usePlanExportActions({
  projectName,
  estimateMethod,
  startDate,
  scheduleError,
  steps,
  teams,
  tags,
  services,
  people,
  priorityBands,
  flat,
  chartRead,
  pushToast,
  mermaidSectionMode,
}: {
  projectName: string | undefined;
  estimateMethod: 'pert' | 'optimistic' | 'realistic' | 'pessimistic';
  startDate: string | null;
  scheduleError: 'cycle' | null;
  steps: StepView[];
  teams: TeamView[];
  tags: TagView[];
  services: ServiceView[];
  people: PersonView[];
  priorityBands: PriorityBandView[];
  flat: TreeRow[];
  chartRead: ChartRead;
  pushToast: (toast: Toast) => void;
  mermaidSectionMode: 'step' | 'outline' | 'assignee';
}) {
  /**
   * The whole plan as a document, taken at the moment it is asked for.
   *
   * **Every row**, not the rows on screen: a collapsed branch and a running
   * search are how one reader is looking at the plan, and an export that
   * carried either would hand somebody else a plan with rows missing and
   * nothing saying so. The figures are be-01's own — the export computes
   * nothing, so it cannot disagree with the table it came off.
   *
   * The timestamp is read here, in the shell, and passed in: the two writers
   * are pure, and a `Date.now()` inside one of them is a header nothing can
   * assert.
   */
  const planForExport = useCallback(
    (): PlanExport => ({
      projectName: projectName ?? UNNAMED_PROJECT,
      generatedAt: new Date().toISOString(),
      method: estimateMethod,
      startDate,
      scheduleError,
      steps,
      teams,
      tags,
      // The service vocabulary the export's `Services` column resolves ids
      // against. Named here beside `tags` and not derived from the rows: the
      // export is self-contained, so it carries the names as they read today.
      services,
      people,
      priorityBands,
      // Every tree row as it came off the wire, not a literal built from one.
      // `toTree` spreads the whole `WorkItemView` (`wbs-rows.ts`), so a column
      // be-01 adds reaches the export the day it reaches the type — which is
      // why `Not before because` needed no line here, against what
      // `not-before-reason`'s proposal owed. Asserted rather than assumed:
      // `exports the words about a not-before date` reads the reason out of a
      // downloaded plan, so a literal introduced here later fails a test rather
      // than silently emptying a column.
      rows: flat,
      // The slices the chart on screen was drawn from, so the export's Ran at
      // column is the same placement the bars are and not a second reading of
      // it. Empty until the first read lands and empty again on a plan that
      // could not be scheduled — both of which the column renders as nothing
      // rather than as a 1.
      slices: chartRead.slices,
    }),
    [
      projectName,
      estimateMethod,
      startDate,
      scheduleError,
      steps,
      teams,
      tags,
      services,
      people,
      priorityBands,
      flat,
      chartRead.slices,
    ],
  );

  /**
   * Puts the plan on the clipboard as Markdown, and says which of the three
   * things that can happen did.
   *
   * A clipboard is a permission, not a function call: the object is absent on
   * an insecure origin and the write can be refused after the object is
   * there. Both are modeled conditions and both are reported — a Copy button
   * that silently does nothing is the failure this whole toast system exists
   * to remove. The success is an `info`, because it is a fact to know rather
   * than a task, and it takes itself off.
   */
  const copyAsMarkdown = useCallback(() => {
    const markdown = planToMarkdown(planForExport());
    // The DOM lib types `navigator.clipboard` as always present. It is not —
    // it is absent on http and in jsdom — so this annotation is the boundary
    // between what the types claim and what a browser actually ships, and it
    // is what makes the check below a real one rather than dead code.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      pushToast({ kind: 'error', text: NO_CLIPBOARD });
      return;
    }
    void clipboard.writeText(markdown).then(
      () => {
        pushToast({ kind: 'info', text: 'Copied as Markdown.' });
      },
      () => {
        // The browser's reason is not shown: it is a permission decision the
        // reader did not make and cannot act on beyond using the other button.
        pushToast({ kind: 'error', text: CLIPBOARD_REFUSED });
      },
    );
  }, [planForExport, pushToast]);

  /**
   * Puts the plan's chart on the clipboard as a Mermaid gantt, or says why there
   * is none. Same three clipboard outcomes as `copyAsMarkdown`, plus a fourth
   * this one has: a plan a gantt cannot be drawn of at all.
   *
   * Drawn in the grouping the Export menu's picker is on, which is the whole of
   * how {@link SectionMode}'s other two modes are reachable from the app.
   */
  const copyAsMermaid = useCallback(() => {
    const diagram = planToMermaid(planForExport(), mermaidSectionMode);
    if (!diagram.drawn) {
      pushToast({ kind: 'error', text: diagram.refusal });
      return;
    }
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      pushToast({ kind: 'error', text: NO_CLIPBOARD });
      return;
    }
    void clipboard.writeText(diagram.text).then(
      () => {
        pushToast({ kind: 'info', text: 'Copied as Mermaid.' });
      },
      () => {
        pushToast({ kind: 'error', text: CLIPBOARD_REFUSED });
      },
    );
  }, [mermaidSectionMode, planForExport, pushToast]);

  /**
   * Downloads the plan as a CSV, without asking be-01 for anything.
   *
   * A blob and an anchor click, which is the only way a page saves a file it
   * generated itself. The object URL is revoked immediately after the click:
   * the download already holds the blob, and an unrevoked URL keeps the whole
   * file in memory for the life of the document.
   *
   * The byte-order mark is for one reader in particular — Excel on Windows
   * reads a UTF-8 CSV as the system codepage without it, which turns every
   * `—` and every non-ASCII name into mojibake. It is added here rather than
   * in {@link planToCsv} because it is a fact about a file, not about the
   * format.
   */
  const downloadCsv = useCallback(() => {
    const plan = planForExport();
    const csv = new Blob([BOM, planToCsv(plan)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(csv);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [planForExport]);

  /**
   * Downloads the plan as a bundled Markdown document — the Mermaid fence plus
   * the table beneath it — or says why there is no diagram to bundle. Refuses
   * exactly where {@link copyAsMermaid} refuses, and for the same reason: a
   * document is the fence plus the table, and there is nothing to bundle around
   * a sentence. Grouped by the same picker {@link copyAsMermaid} reads: one
   * choice for the fence, whichever way it leaves the app.
   */
  const downloadMermaidDocument = useCallback(() => {
    const plan = planForExport();
    const bundle = planToMermaidDocument(plan, mermaidSectionMode);
    if (!bundle.drawn) {
      pushToast({ kind: 'error', text: bundle.refusal });
      return;
    }
    const markdown = new Blob([bundle.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(markdown);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan, 'md');
    anchor.click();
    URL.revokeObjectURL(url);
  }, [mermaidSectionMode, planForExport, pushToast]);

  /**
   * The chart's own `.svg` downloader while there is a chart, and `null` while
   * there is not.
   *
   * A ref and not state: nothing on this page is drawn differently for holding
   * it, and a `setState` from the panel's mount effect would re-render the
   * whole table for a fact only a click reads. What registers it is
   * {@link GanttPanel}'s `registerSvgDownload`, which is documented there.
   */
  const chartSvgDownload = useRef<(() => void) | null>(null);

  /**
   * Stable, so the panel registers once per mount rather than on every render
   * of this table — the effect that calls it lists it as its only dependency.
   */
  const registerSvgDownload = useCallback((download: (() => void) | null) => {
    chartSvgDownload.current = download;
  }, []);

  /**
   * The fifth thing the Export menu can do, and the only one that is not made
   * of the plan's own text: the chart, as the picture it is on screen.
   *
   * Refuses the way the two Mermaid exports refuse — a toast naming the way out
   * — and for a nearer reason: there is no chart mounted to take a drawing off.
   * See {@link NO_CHART_TO_DOWNLOAD}.
   *
   * Proof: with the refusal made a silent `download?.()`, `refuses the chart
   * the menu has no drawing of, and says where it is` fails on `expected [] to
   * deeply equal [ Array(1) ]` — no toast where one was owed. The same output
   * comes of deleting the panel's own registration cleanup, which is the other
   * half of the same contract; both watched 2026-08-31.
   */
  const downloadChartSvg = useCallback(() => {
    const download = chartSvgDownload.current;
    if (download === null) {
      pushToast({ kind: 'error', text: NO_CHART_TO_DOWNLOAD });
      return;
    }
    download();
  }, [pushToast]);
  return {
    planForExport,
    copyAsMarkdown,
    copyAsMermaid,
    downloadCsv,
    downloadMermaidDocument,
    registerSvgDownload,
    downloadChartSvg,
  };
}

/** Coordinates the table’s plan export actions state and actions. */
export function usePlanOnScreenExport({
  planForExport,
  shownRows,
  flat,
  criteria,
  filterLabels,
}: {
  planForExport: () => PlanExport;
  shownRows: Row<PlanTableFeatures, TreeRow>[];
  flat: TreeRow[];
  criteria: FilterCriteria;
  filterLabels: FilterLabels;
}) {
  /**
   * The plan as one reader has it on screen: the rows the filter and the
   * collapse left, and a {@link FilteredScope} saying so.
   *
   * **A second export action and never a mode on the four above** — R10 §9's
   * Q3, settled 2026-08-17. Those four keep taking `flat` and keep claiming the
   * whole plan, because a button whose header says "the whole plan" is how
   * somebody hands a client a plan with rows missing. This one says what it is
   * in its own `Scope` line, in its file name, and in the fence's comment if it
   * ever grows one.
   *
   * Down here rather than beside {@link planForExport} because this is the one
   * export that needs `shownRows`, which is the table's own row model narrowed
   * — the same list the chart and the cards draw, so what this writes out is
   * what all three are showing and not a fourth answer.
   *
   * The figures are untouched: `slices` is the whole chart read and every date
   * is be-01's, computed over the whole plan whatever is on screen. The `Scope`
   * line says that out loud, because a reader holding a document of six rows
   * has no way to tell whether the dates were re-planned for them.
   */
  const planOnScreen = (): PlanExport => ({
    ...planForExport(),
    rows: shownRows.map((row) => row.original),
    scope: {
      totalRows: flat.length,
      // The filter's own account of itself — `filterWords`, the same criteria
      // object `narrowTree` was asked with and the same {@link filterLabels}
      // the saved-views panel reads, so the document cannot describe a
      // narrowing other than the one that produced its rows.
      criteria: filterWords(criteria, filterLabels),
    },
  });

  /**
   * Downloads what is on screen as a Markdown table with a `Scope` header.
   *
   * The **table** and not the bundled Mermaid document, which is the one thing
   * this action deliberately gives up: a document refuses when there is no
   * chart to draw (no start date, no schedule, nothing placed), and a filter
   * narrowed to parent rows alone places nothing — so the bundle would refuse
   * exactly where a reader most wants the rows they are looking at. A table
   * always writes.
   */
  const downloadOnScreen = (): void => {
    const plan = planOnScreen();
    const markdown = new Blob([planToMarkdown(plan)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(markdown);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan, 'md');
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return { downloadOnScreen };
}

/**
 * What an export calls a project it was not told the name of.
 *
 * The picker always supplies one, so this is what a caller that has no picker
 * produces — a document that says it does not know, rather than one carrying a
 * uuid nobody can read or none at all.
 */
export const UNNAMED_PROJECT = 'Untitled plan';

/**
 * What a page with no clipboard says.
 *
 * `navigator.clipboard` is absent entirely on an insecure origin — the dev
 * deployment is one — so this is a condition to report, not a failure to
 * throw on. It names the way out, which is the CSV beside it.
 */
export const NO_CLIPBOARD =
  'This page has no clipboard — that needs an https address. Download the CSV instead.';

/**
 * What the Export menu says when it is asked for a chart nobody is looking at.
 *
 * A modeled state and not a failure: the file is built by nesting a clone of
 * the **live** `<svg>` (`gantt-panel.tsx`, `buildStandaloneGanttSvg`), so a
 * closed chart — or a plan whose dependencies run in a circle, which draws a
 * sentence instead of a chart — has nothing to serialize. It names the way
 * out, as the two above do.
 */
export const NO_CHART_TO_DOWNLOAD =
  'There is no chart on screen to download. Open the Gantt and try again.';

/** What a clipboard that refused the write says. The permission is the browser's to give. */
export const CLIPBOARD_REFUSED =
  'The browser refused the clipboard, so nothing was copied. Download the CSV instead.';

/**
 * The byte-order mark the downloaded CSV starts with.
 *
 * Written as an escape rather than as the character it is: U+FEFF is
 * zero-width, and a literal one in the source is a byte nobody reviewing this
 * file can see.
 */
export const BOM = '\uFEFF';
