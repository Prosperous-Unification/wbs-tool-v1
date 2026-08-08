import Markdown from 'react-markdown';

export interface NotesPreviewProps {
  notes: string;
  /** Named in the popover so a hover on a busy table says which row it belongs to. */
  number: string;
}

/**
 * The rendered note, shown on hover over the Name cell it is written in.
 *
 * The cell shows a note as the plain lines under the name, capped at four so a
 * plan still fits on a screen. This is where the rest of a long one is read,
 * and the only place its markdown is rendered.
 *
 * `react-markdown` renders to React elements and does **not** pass raw HTML
 * through — no `rehype-raw` here, deliberately. Notes are written by one
 * person and read by everyone else on the project, so a note containing a
 * `<script>` or an `onerror` attribute must render as the text somebody typed
 * and nothing else. That is the whole reason this is a markdown renderer
 * rather than `dangerouslySetInnerHTML` over a converted string.
 */
export function NotesPreview({ notes, number }: NotesPreviewProps) {
  return (
    <div
      role="tooltip"
      aria-label={`Notes for ${number}, rendered`}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 20,
        minWidth: 260,
        maxWidth: 420,
        maxHeight: 320,
        overflowY: 'auto',
        background: '#fff',
        border: '1px solid #ccc',
        borderRadius: 4,
        padding: '4px 8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        textAlign: 'left',
        fontWeight: 400,
      }}
    >
      <Markdown>{notes}</Markdown>
    </div>
  );
}
