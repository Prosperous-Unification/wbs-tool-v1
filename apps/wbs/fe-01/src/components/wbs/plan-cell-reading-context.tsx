import { createContext, type ReactNode, useContext } from 'react';

const StartSentenceContext = createContext<string | null | undefined>(undefined);
const FilterReadingContext = createContext<{ filtering: boolean; matched: boolean } | undefined>(
  undefined,
);

/** Supplies the two filter readings only Number and Name render. */
export function FilterReadingProvider({
  filtering,
  matched,
  children,
}: {
  filtering: boolean;
  matched: boolean;
  children: ReactNode;
}) {
  return <FilterReadingContext value={{ filtering, matched }}>{children}</FilterReadingContext>;
}

/** Reads the filter state supplied at a filter-sensitive cell boundary. */
export function useFilterReading(): { filtering: boolean; matched: boolean } {
  const reading = useContext(FilterReadingContext);
  if (reading === undefined) throw new Error('Filter-sensitive cell rendered without its reading');
  return reading;
}

/** Supplies the Gantt-derived Start sentence to the one cell that renders it. */
export function StartSentenceProvider({
  sentence,
  children,
}: {
  sentence: string | null;
  children: ReactNode;
}) {
  return <StartSentenceContext value={sentence}>{children}</StartSentenceContext>;
}

/** Reads the Start sentence supplied by the table's explicit cell boundary. */
export function useStartSentence(): string | null {
  const sentence = useContext(StartSentenceContext);
  // Proof: omitting StartSentenceProvider at the production cell boundary made
  // `keeps explicit unchanged cells behind their stable component boundary`
  // fail with `Start cell rendered without its sentence`. Watched 2026-09-08.
  if (sentence === undefined) throw new Error('Start cell rendered without its sentence');
  return sentence;
}
