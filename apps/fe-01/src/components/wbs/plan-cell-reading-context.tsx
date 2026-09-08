import { createContext, type ReactNode, useContext } from 'react';

const StartSentenceContext = createContext<string | null | undefined>(undefined);

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
