import { refLabelOf, systemOfUrl } from '@wbs/domain/external-system';
import { useState } from 'react';

import { type ExternalRefView, type ExternalSystemView, followableHref } from '@/lib/wbs-api';

import { Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '../ui/modal';

/** A ref as this editor states it — the shape the patch takes, with no minted id. */
export interface ExternalRefDraft {
  systemId: string;
  url: string;
  /**
   * What the reader calls this link, or `''` for one they have not named.
   *
   * Stated on every draft rather than optional, because every act here sends
   * the **whole** list: a draft that left the field off would take the names off
   * every other row in the list it is stating.
   */
  name: string;
}

export interface ExternalRefsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The work item's number, so the surface says whose links these are. */
  number: string;
  /** The refs as they stand, in order. */
  refs: readonly ExternalRefView[];
  /** The directory's vocabulary — what a system may be set to. */
  systems: readonly ExternalSystemView[];
  /**
   * States the whole list, in order.
   *
   * **Whole, never a delta**, and that is not this component's convenience: the
   * patch is a replacement (`tagIds`' rule), so every act here — an add, a
   * URL edit, a system change, a removal — sends the list as it will stand.
   * Undo restores the list it replaced, which it can only do because the list
   * was stated rather than merged.
   */
  onReplace: (refs: readonly ExternalRefDraft[]) => void;
}

/**
 * The system a pasted URL types itself as, as an id, or `''` for one no rule
 * claims.
 *
 * **The derivation runs here and its answer is then just a value in a select**
 * — the reader can change it before the ref is ever stored, and after it is
 * stored nothing re-derives (design D1). `''` is the reader's cue that the
 * paste was not recognised, not a failure: the editor refuses to add until a
 * system is named, which is the spec's "the ref SHALL NOT be stored until a
 * system is named".
 *
 * A name the deriver answers that this directory does not hold answers `''` as
 * well. That is a real state during a swap — an fe-01 holding a newer rule
 * against a be-01 whose vocabulary has not been migrated — and offering an id
 * the write would refuse with `unknown_system` is worse than asking.
 */
export function derivedSystemId(url: string, systems: readonly ExternalSystemView[]): string {
  const name = systemOfUrl(url);
  if (name === null) return '';
  return systems.find((system) => system.name === name)?.id ?? '';
}

/** The vocabulary as a `<select>`, used by the add row and by every stored row. */
function SystemChoice({
  label,
  value,
  systems,
  onChange,
}: {
  label: string;
  value: string;
  systems: readonly ExternalSystemView[];
  onChange: (systemId: string) => void;
}) {
  return (
    <select
      aria-label={label}
      className="border-input bg-background h-8 shrink-0 rounded-md border px-2 text-sm"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">Choose a system</option>
      {systems.map((system) => (
        <option key={system.id} value={system.name}>
          {system.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The ref list, edited: add from a pasted URL, change a system or a URL, remove
 * one.
 *
 * **The editor is a modal and not a cell popover**, because the cell is 40px and
 * cannot hold a picker (design D4) — which is also why this dimension does not
 * join the `ReferenceSetStrip` family even though its *vocabulary* behaves like
 * the tags'. Reordering is deliberately not offered: the order is the order the
 * refs were added (the proposal's last non-goal).
 *
 * Every act writes the **whole** list through {@link ExternalRefsModalProps.onReplace}
 * as it happens, rather than collecting an edit and saving on close. A surface
 * with a Save button is a surface a reader can leave with unsaved work in it,
 * and the write is a single replacement either way.
 *
 * A stored URL is followable here on exactly the card's terms —
 * {@link followableHref} — because the rule is about the *URL*, not about which
 * surface is drawing it, and a guard written twice is a guard that gets deleted
 * once.
 */
export function ExternalRefsModal({
  open,
  onOpenChange,
  number,
  refs,
  systems,
  onReplace,
}: ExternalRefsModalProps) {
  const [typedUrl, setTypedUrl] = useState('');
  const [chosenSystemId, setChosenSystemId] = useState('');
  /**
   * The name the reader has typed into the add row, or `null` for one who has
   * not typed in it at all.
   *
   * **`null` and not `''`, because the two are different answers.** Nobody has
   * touched the box is what the derived label fills; a reader who typed a name
   * and then cleared it has said *no name*, and a `''` sentinel would put the
   * derived label straight back under their cursor.
   */
  const [typedName, setTypedName] = useState<string | null>(null);
  /**
   * The system the add row will use: whatever the reader chose, or what the URL
   * derived while they have chosen nothing.
   *
   * Read rather than stored, so a reader who pastes a second URL over the first
   * gets the second one's answer instead of the first one's — a `useEffect`
   * syncing a state to a prop is the version of this that shows the wrong
   * system for one render.
   */
  const addingSystemId =
    chosenSystemId === '' ? derivedSystemId(typedUrl, systems) : chosenSystemId;
  /**
   * The name the add row will use: whatever the reader typed, or the label the
   * URL derives while they have typed nothing.
   *
   * {@link addingSystemId}'s shape exactly, read rather than synced, and for its
   * reason: a `useEffect` copying the derivation into state shows the *first*
   * URL's label for one render after the second is pasted.
   *
   * A real value and not a placeholder, which is the one thing this box does
   * differently from the stored rows below. Dany's example is `ticket key +
   * summary`, and the key is the half a URL carries — so the box is filled with
   * `WCN-3892` and the reader types the summary after it. A placeholder would
   * make them retype the key they can already see.
   */
  const addingName = typedName ?? refLabelOf(typedUrl);
  const stated = (): ExternalRefDraft[] =>
    refs.map((ref) => ({ systemId: ref.systemId, url: ref.url, name: ref.name }));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/*
        No `aria-label`: Radix points `aria-labelledby` at {@link ModalTitle},
        and an `aria-label` here would be a second name for the same surface —
        which is not a tidiness point, it is what made `Links for 010` match the
        dialog *and* the cell button beneath it and broke two tests on
        `Found multiple elements with the text of: Links for 010`.
      */}
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{`Links for ${number}`}</ModalTitle>
          <ModalDescription>
            Where this work also exists. Nothing is fetched — a ref is a link.
          </ModalDescription>
        </ModalHeader>
        <div data-refs-editor className="flex flex-col gap-3">
          {refs.map((ref, at) => {
            const href = followableHref(ref.url);
            return (
              <div
                key={ref.id}
                data-refs-editor-row={ref.id}
                className="bg-muted/40 flex flex-col gap-2 rounded-md p-2"
              >
                {/*
                  The name on its own line above the address, because a name is
                  the thing a reader reads and a URL is the thing they follow.
                  Five controls on one line gave the name about ninety pixels,
                  which is not a box you can type `WCN-3892 Cache warm-up` into.
                */}
                <input
                  aria-label={`Name of link ${String(at + 1)}`}
                  className="border-input bg-background h-8 min-w-0 rounded-md border px-2 text-sm font-medium"
                  defaultValue={ref.name}
                  // The derived label as a **placeholder** here and as a real
                  // value on the add row, and the difference is deliberate: a
                  // stored `''` means nobody has named this link, every surface
                  // already draws `refLabelOf` in its place, and prefilling the
                  // box with that would turn a fallback that improves with the
                  // rules into a value frozen on the day somebody opened this
                  // dialog.
                  placeholder={refLabelOf(ref.url)}
                  // On the blur and on Enter, for the URL box's reason one line
                  // down: a patch per keystroke is one undo entry per keystroke.
                  onBlur={(event) => {
                    if (event.target.value === ref.name) return;
                    const next = stated();
                    next[at] = { systemId: ref.systemId, url: ref.url, name: event.target.value };
                    onReplace(next);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <div className="flex items-center gap-2">
                  <SystemChoice
                    label={`System of link ${String(at + 1)}`}
                    value={systems.find((system) => system.id === ref.systemId)?.name ?? ''}
                    systems={systems}
                    onChange={(name) => {
                      const chosen = systems.find((system) => system.name === name);
                      if (chosen === undefined) return;
                      const next = stated();
                      next[at] = { systemId: chosen.id, url: ref.url, name: ref.name };
                      onReplace(next);
                    }}
                  />
                  <input
                    aria-label={`URL of link ${String(at + 1)}`}
                    className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-sm"
                    defaultValue={ref.url}
                    // On the blur and on Enter, never per keystroke: each write is
                    // a whole-list replacement and a patch per character would be
                    // one undo entry per character.
                    onBlur={(event) => {
                      if (event.target.value === ref.url) return;
                      const next = stated();
                      next[at] = {
                        systemId: ref.systemId,
                        url: event.target.value,
                        name: ref.name,
                      };
                      onReplace(next);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                  {href === null ? (
                    // The refusal is visible rather than silent: a URL the app
                    // will not follow says so where the Follow link would be.
                    <span
                      data-refs-editor-url={ref.id}
                      className="text-muted-foreground shrink-0 text-xs"
                      data-fact="Only http and https links can be followed"
                    >
                      {ref.url}
                    </span>
                  ) : (
                    <a
                      data-refs-editor-url={ref.id}
                      className="shrink-0 text-sm underline"
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Follow
                    </a>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove link ${String(at + 1)}`}
                    className="text-muted-foreground hover:text-foreground shrink-0 text-sm"
                    onClick={() => {
                      onReplace(stated().filter((_, index) => index !== at));
                    }}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div data-refs-add className="flex flex-col gap-2 border-t pt-3">
          {/*
            The URL first and the name under it, which is the order the reader
            works in: they paste an address, and the box below fills itself with
            whatever that address calls itself.
          */}
          <input
            aria-label="Paste a URL"
            className="border-input bg-background h-8 min-w-0 rounded-md border px-2 text-sm"
            placeholder="Paste a URL"
            value={typedUrl}
            onChange={(event) => {
              setTypedUrl(event.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            <input
              aria-label="Name of the new link"
              className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-sm font-medium"
              placeholder="Name this link"
              value={addingName}
              onChange={(event) => {
                setTypedName(event.target.value);
              }}
            />
            <SystemChoice
              label="System of the new link"
              value={systems.find((system) => system.id === addingSystemId)?.name ?? ''}
              systems={systems}
              onChange={(name) => {
                setChosenSystemId(systems.find((system) => system.name === name)?.id ?? '');
              }}
            />
            <button
              type="button"
              // Refused rather than guessed at: a ref with no system is not
              // storable (be-01 answers `unknown_system`), so the control that
              // would send one is disabled and the select beside it is where the
              // reader says which.
              className="bg-primary text-primary-foreground h-8 shrink-0 rounded-md px-3 text-sm disabled:opacity-50"
              disabled={typedUrl === '' || addingSystemId === ''}
              onClick={() => {
                onReplace([
                  ...stated(),
                  { systemId: addingSystemId, url: typedUrl, name: addingName },
                ]);
                setTypedUrl('');
                setChosenSystemId('');
                // Back to "nobody has typed here", not to the empty string: the
                // next URL pasted has to be able to fill this box again.
                setTypedName(null);
              }}
            >
              Add link
            </button>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
