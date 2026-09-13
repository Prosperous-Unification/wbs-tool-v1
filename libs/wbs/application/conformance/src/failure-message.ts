/** Renders nested lifecycle failures without discarding aggregate members. */
export function failureMessage(failure: unknown): string {
  if (!(failure instanceof AggregateError)) {
    return failure instanceof Error ? failure.message : String(failure);
  }

  const members = failure.errors.map((member: unknown) => failureMessage(member));
  return members.length === 0 ? failure.message : `${failure.message}: [${members.join('; ')}]`;
}
