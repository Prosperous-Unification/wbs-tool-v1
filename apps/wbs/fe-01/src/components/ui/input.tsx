import { forwardRef, type InputHTMLAttributes } from 'react';

import { type Factable, type Hintable } from '@/components/wbs/hint';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, Hintable, Factable {}

/**
 * A chrome text box.
 *
 * Chrome only, for {@link import('./button').Button}'s reason: an input inside
 * `[data-grid]` is a cell, the scoped reset does not reach it, and
 * `table-frame.ts` sized the columns around what a browser draws unaided.
 *
 * `w-full` is the registry's default and is kept, so this box fills whatever
 * it is put in. The two places that need a narrower one — the Find box and the
 * project picker — pass a width class of their own rather than this component
 * growing a `size` variant nobody else would use.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
