import type { AppliedFor, CommandBindings, CommandFor } from './command-bindings';

export function bindingTypeCases(
  bindings: CommandBindings,
  setEstimateApplied: AppliedFor<'setEstimate'>,
  clearEstimateApplied: AppliedFor<'clearEstimate'>,
  createPersonApplied: AppliedFor<'createPerson'>,
  createTeamApplied: AppliedFor<'createTeam'>,
) {
  const _validPlainBinding: CommandBindings['setEstimate'] = () =>
    Promise.resolve(setEstimateApplied);
  const _validEntityBinding: CommandBindings['createPerson'] = () =>
    Promise.resolve(createPersonApplied);

  const { setEstimate: _setEstimate, ...bindingsWithoutSetEstimate } = bindings;
  // Proof: making binding keys optional produced TS2578 here, beside the dispatch's
  // possibly-undefined diagnostic.
  // @ts-expect-error Every definition requires its own binding.
  const _incompleteBindings: CommandBindings = bindingsWithoutSetEstimate;

  // Proof: correlating setEstimate to clearEstimate input produced TS2578 here.
  // @ts-expect-error A setEstimate binding cannot accept clearEstimate input.
  const _wrongInput: CommandBindings['setEstimate'] = (_command: CommandFor<'clearEstimate'>) =>
    Promise.resolve(setEstimateApplied);

  const _wrongPlainResponse: CommandBindings['setEstimate'] = () =>
    // Proof: widening binding output to AppliedCommand produced TS2578 here and in
    // the createPerson/createTeam fixture below.
    // @ts-expect-error A setEstimate binding cannot return clearEstimate's kind.
    Promise.resolve(clearEstimateApplied);

  const _wrongEntityResponse: CommandBindings['createPerson'] = () =>
    // @ts-expect-error A createPerson binding cannot return createTeam's kind or entity.
    Promise.resolve(createTeamApplied);

  return {
    _validPlainBinding,
    _validEntityBinding,
    _incompleteBindings,
    _wrongInput,
    _wrongPlainResponse,
    _wrongEntityResponse,
  };
}
