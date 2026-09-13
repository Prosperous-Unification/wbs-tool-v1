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
import { shortIsoDate } from './short-date';

export interface CompletionPromptProps {
  /** The row's number, so the surface says which work item is being finished. */
  number: string;
  /**
   * The fact end the row already holds, or `null`. Offered in the field when
   * held, so confirming unchanged keeps a day somebody typed; today is offered
   * otherwise.
   */
  heldFactEnd: IsoDate | null;
  /** The reader's own calendar day — never UTC's, `use-plan-fields.ts`'s rule. */
  today: IsoDate;
  /** The day in the field, once, on `Mark done` or Enter. Never with a non-date. */
  onConfirm: (day: IsoDate) => void;
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
 * The **completion prompt**: the dialog between choosing `Done` in the Status
 * cell and the write.
 *
 * It exists because the day a row finished is a fact about the world and not
 * about the click: `work-item-status-and-facts` filled the fact end with today
 * silently, which is right for a row finished at the desk and wrong for one
 * finished last Thursday. So `Done` asks, with today offered — or the day the
 * row already holds — and the answer rides `setStatus` as `on`
 * (`status-at-a-glance` D5). A date and not a time: every date on `work_item`
 * is a day with no zone (ADR 0024), and the prompt offers what the column can
 * hold.
 *
 * **Cancelling writes nothing.** The status is not changed and then asked
 * about; the prompt's confirmation *is* the act, so Cancel, Escape and a click
 * outside leave the row exactly as it was. `Mark done` is held back while the
 * field does not hold a calendar day — an empty field or a half-typed year —
 * so `on` can never be `''`, which the Fact end cell would refuse as a malformed
 * day after the write had already been journalled.
 *
 * A plain controlled `<input type="date">` and not {@link DateField}: that
 * component exists to hold a half-typed day against a server answer landing
 * mid-word, and nothing lands here — the field's only reader is this surface,
 * and Enter has to submit the form, which the field's own Enter would swallow.
 * `Modal` gives it the focus trap, the return of focus to the Status cell on
 * close, and the page's keyboard held back for as long as it is on screen.
 */
export function CompletionPrompt({
  number,
  heldFactEnd,
  today,
  onConfirm,
  onOpenChange,
  onClosed,
}: CompletionPromptProps) {
  const [day, setDay] = useState<string>(heldFactEnd ?? today);
  const valid = isIsoDate(day);
  const submit = (): void => {
    // Proof: this guard removed and the button's `disabled` with it, and
    // `holds Mark done back while the day is not a date` fails on `expected
    // false to be true` at the button, before the forced submit could confirm
    // `''`; watched 2026-09-13.
    if (!valid) return;
    onConfirm(day);
  };
  const fieldId = `completion-day-${number}`;
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
          <ModalTitle>Mark {number} done</ModalTitle>
          <ModalDescription>
            Every step of {number} will say done, and the day below becomes its Fact end — where its
            bar stops on the chart, whatever the estimate says.
            {heldFactEnd !== null &&
              ` It already holds ${shortIsoDate(heldFactEnd, new Date(`${today}T12:00:00`))}; keep it or change it.`}
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <label htmlFor={fieldId} className="flex flex-col gap-1 text-sm">
            Finished on
            <input
              id={fieldId}
              type="date"
              name="day"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={day}
              onChange={(event) => {
                setDay(event.currentTarget.value);
              }}
            />
          </label>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </ModalClose>
            <Button type="submit" disabled={!valid}>
              Mark done
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
