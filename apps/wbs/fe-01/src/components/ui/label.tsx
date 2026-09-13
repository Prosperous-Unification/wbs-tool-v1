import { forwardRef, type LabelHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

/**
 * The caption above a chrome field.
 *
 * A plain `<label>`, where the registry's version wraps
 * `@radix-ui/react-label`. That package exists to make a click on the caption
 * focus the control in browsers whose native `label` behaviour it predates;
 * every browser this app supports does it natively, and the forms here nest
 * their control inside the label anyway, which is the association that needs no
 * `htmlFor` at all.
 */
export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, ...props },
  ref,
) {
  return (
    // The control this labels arrives as `children` at the call site, so the
    // association cannot be seen from inside this component and the rule is
    // right that it cannot see one. What makes it safe is that the association
    // is asserted rather than argued: every caller nests its control, and every
    // test and browser spec finds those controls by `getByLabel('Username')`,
    // `getByLabel('Password')` — a query that resolves through the accessibility
    // tree and fails outright if the nesting is ever undone.
    // eslint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      ref={ref}
      className={cn('grid gap-1.5 text-sm leading-none font-medium', className)}
      {...props}
    />
  );
});
