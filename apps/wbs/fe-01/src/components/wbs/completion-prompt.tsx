import { isIsoDate, type IsoDate } from '@wbs/domain/workday';
import { useState } from 'react';

import { Button } from '../ui/button';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/modal';
import { withLeadWord } from './lead-word';

/** The engine's two days for the row, as the table shows them, or null on an undated plan. */
export interface ForecastSpan {
  startsOn: IsoDate;
  endsOn: IsoDate;
}

export interface CompletionPromptProps {
  /** The row's number, so the surface says which work item is being finished. */
  number: string;
  /** The fact start the row already holds, or `null`. Offered when held. */
  heldFactStart: IsoDate | null;
  /** The fact end the row already holds, or `null`. Offered when held. */
  heldFactEnd: IsoDate | null;
  /** What the engine forecast for the row, which the two fields default to. */
  forecast: ForecastSpan | null;
  /** The reader's own calendar day — never UTC's, `use-plan-fields.ts`'s rule. */
  today: IsoDate;
  /** Both days in the fields, once, on `Mark done` or Enter. Never with a non-date. */
  onConfirm: (started: IsoDate, finished: IsoDate) => void;
  /** `false` on Cancel, Escape or a click outside — the prompt is dismissed and nothing was sent. */
  onOpenChange: (open: boolean) => void;
  /**
   * Where the focus goes once the surface is gone, confirmed or dismissed.
   *
   * Radix would put it back on the element that had it when the prompt
   * opened — the picker's `Done` line, which the picker has closed and
   * unmounted by then, so the focus fell to `<body>` and the keyboard walk was
   * lost. Watched in Chromium (`e2e/status.spec.ts`, `toBeFocused` on the
   * Status cell: `Received: inactive`), 2026-09-13. The caller knows which cell
   * asked; this hands it the moment.
   */
  onClosed: () => void;
}

/**
 * What the start field opens with: the day already recorded, else the
 * forecast start, else today. The forecast is the engine's own guess at when
 * the work began, and a planner marking a row done rarely knows better — but
 * can type over it (Dany, 2026-09-13: "by default it is set to the forecast
 * start date (and it is explicitly marked as same as forecast date)").
 */
export function defaultFactStart(
  heldFactStart: IsoDate | null,
  forecast: ForecastSpan | null,
  today: IsoDate,
): IsoDate {
  return heldFactStart ?? forecast?.startsOn ?? today;
}

/**
 * What the end field opens with: the day already recorded, else today while the
 * forecast end is still ahead, else the forecast end. A row marked done after
 * its forecast end most likely finished on the forecast, not on the day the
 * planner got round to marking it (Dany, 2026-09-13: "only set it to current
 * date if done status is set up before the forecast date, if it is after the
 * forecast date select the forecasted end date by default").
 */
export function defaultFactEnd(
  heldFactEnd: IsoDate | null,
  forecast: ForecastSpan | null,
  today: IsoDate,
): IsoDate {
  if (heldFactEnd !== null) return heldFactEnd;
  if (forecast !== null && today > forecast.endsOn) return forecast.endsOn;
  return today;
}

/**
 * What a field's day is, in words beside it: the recorded day, the forecast's,
 * today, or a day the reader typed. Read off the field's current value, so the
 * note follows a change rather than describing the default it opened with.
 */
export function dayNote(
  day: string,
  held: IsoDate | null,
  forecastDay: IsoDate | null,
  today: IsoDate,
  forecastWord: 'start' | 'end',
): string {
  if (!isIsoDate(day)) return 'Not a calendar day yet.';
  if (held !== null && day === held) return 'The day already recorded on this row.';
  if (forecastDay !== null && day === forecastDay) return `Same as the forecast ${forecastWord}.`;
  if (day === today) return 'Today.';
  return 'A day you typed.';
}

/**
 * The **completion prompt**: the dialog between choosing `Done` in the Status
 * cell — or `Mark done…` on the row's ⋯ — and the write.
 *
 * It exists because the days a row began and finished are facts about the world
 * and not about the click: `work-item-status-and-facts` filled the fact end
 * with today silently, which is right for a row finished at the desk and wrong
 * for one finished last Thursday. So `Done` asks, with the engine's forecast as
 * the starting point — the forecast start for the start, and for the end today
 * or the forecast end, whichever the row is more likely to have finished on
 * ({@link defaultFactStart}, {@link defaultFactEnd}) — and says beside each
 * field what its day is ({@link dayNote}). The answer rides `setStatus` as
 * `on` and `factStart` (`status-at-a-glance` D5, extended 2026-09-13). Dates
 * and not times: every date on `work_item` is a day with no zone (ADR 0024).
 *
 * **Cancelling writes nothing.** The status is not changed and then asked
 * about; the prompt's confirmation *is* the act, so Cancel, Escape and a click
 * outside leave the row exactly as it was. `Mark done` is held back while
 * either field does not hold a calendar day, so neither day can be `''`.
 *
 * Plain controlled `<input type="date">`s and not {@link DateField}: that
 * component exists to hold a half-typed day against a server answer landing
 * mid-word, and nothing lands here; and Enter has to submit the form, which the
 * field's own Enter would swallow. `Modal` gives the focus trap, the page's
 * keyboard held back, and the return of focus through {@link onClosed}.
 */
export function CompletionPrompt({
  number,
  heldFactStart,
  heldFactEnd,
  forecast,
  today,
  onConfirm,
  onOpenChange,
  onClosed,
}: CompletionPromptProps) {
  const [started, setStarted] = useState<string>(defaultFactStart(heldFactStart, forecast, today));
  const [finished, setFinished] = useState<string>(defaultFactEnd(heldFactEnd, forecast, today));
  const valid = isIsoDate(started) && isIsoDate(finished);
  const submit = (): void => {
    // Proof: this guard removed and the button's `disabled` with it, and
    // `holds Mark done back while a day is not a date` fails on `expected
    // false to be true` at the button, before the forced submit could confirm
    // `''`; watched 2026-09-13.
    if (!valid) return;
    onConfirm(started, finished);
  };
  const startId = `completion-start-${number}`;
  const endId = `completion-end-${number}`;
  return (
    <Modal open onOpenChange={onOpenChange}>
      <ModalContent
        side="centre"
        closeButton={false}
        className="max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <ModalHeader>
          <ModalTitle>
            Set {number} to {withLeadWord('Done', { word: 'Done', tone: 'done' })}
          </ModalTitle>
          <ModalDescription>
            Every step of {number} will say done. The two days below become its Fact start and Fact
            end — the span its bar is drawn over, whatever the estimate says.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={startId}>Started on</label>
            <input
              id={startId}
              type="date"
              name="started"
              aria-describedby={`${startId}-note`}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={started}
              onChange={(event) => {
                setStarted(event.currentTarget.value);
              }}
            />
            <span
              id={`${startId}-note`}
              className="text-muted-foreground text-xs"
              data-day-note="started"
            >
              {dayNote(started, heldFactStart, forecast?.startsOn ?? null, today, 'start')}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={endId}>Finished on</label>
            <input
              id={endId}
              type="date"
              name="finished"
              aria-describedby={`${endId}-note`}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={finished}
              onChange={(event) => {
                setFinished(event.currentTarget.value);
              }}
            />
            <span
              id={`${endId}-note`}
              className="text-muted-foreground text-xs"
              data-day-note="finished"
            >
              {dayNote(finished, heldFactEnd, forecast?.endsOn ?? null, today, 'end')}
            </span>
          </div>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </ModalClose>
            <Button type="submit" disabled={!valid}>
              Set to Done
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
