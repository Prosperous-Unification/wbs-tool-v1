export interface InjectedClock {
  now(): number;
  advance(deltaMs: number): void;
}

export function injectedClock(startMs = 0): InjectedClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (delta: number) => {
      current += delta;
    },
  };
}
