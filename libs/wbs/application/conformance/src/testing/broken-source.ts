import type { FaultControl, FaultId, FaultRun } from './faults';

type MethodKey<Subject> = {
  [Key in keyof Subject]-?: Subject[Key] extends (...arguments_: never[]) => unknown ? Key : never;
}[keyof Subject];

type MethodAt<Subject, Key extends keyof Subject> = Extract<
  Subject[Key],
  (...arguments_: never[]) => unknown
>;

/** Replaces one method while binding every forwarded method to its real owner. */
export function replaceMethod<Subject extends object, Key extends MethodKey<Subject>>(
  subject: Subject,
  key: Key,
  replace: (original: MethodAt<Subject, Key>) => MethodAt<Subject, Key>,
): Subject {
  // MethodKey proves this indexed member callable before it crosses the Proxy boundary.
  const original = subject[key] as MethodAt<Subject, Key>;
  const bound = original.bind(subject) as MethodAt<Subject, Key>;
  const replacement = replace(bound);
  return new Proxy(subject, {
    get(target, property): unknown {
      const member: unknown =
        property === key ? replacement : Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...arguments_: unknown[]): unknown => {
        const returned: unknown = Reflect.apply(member, target, arguments_);
        return returned;
      };
    },
  });
}

/** Decorates each opened source with one inert-until-armed named fault. */
export function brokenSource<
  Arguments extends readonly unknown[],
  Opened,
  Phase extends string,
  Control extends FaultControl<Phase>,
>(
  open: (...arguments_: Arguments) => Opened,
  fault: FaultRun<Opened, FaultId, Phase, Control>,
): (...arguments_: Arguments) => Opened {
  let hasOpened = false;
  return (...arguments_) => {
    if (hasOpened) throw new Error(`fault run ${fault.id} opened more than one source`);
    hasOpened = true;
    return fault.mutate(open(...arguments_), fault.control);
  };
}
