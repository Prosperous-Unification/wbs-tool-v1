import { cva, type VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef } from 'react';

import { type Factable, type Hintable } from '@/components/wbs/hint';
import { cn } from '@/lib/utils';

/**
 * Every shape a chrome button comes in, and the tokens each one reads.
 *
 * Colours are named, never mixed: `bg-primary` and `text-primary-foreground`
 * are custom properties `styles.css` sets, which is what makes the dark set a
 * re-point of the palette rather than a second copy of this file.
 *
 * This is the shadcn registry's own variant table with two removals. There is
 * no `asChild`, because it needs `@radix-ui/react-slot` and nothing in this app
 * renders a button as a link. And there is no `icon` size with a lucide glyph
 * in it: this app's icons are its own — text where a codepoint reads (`✕`) and
 * inline SVG where one does not (`wbs/toolbar-icons.tsx`, since the plan
 * toolbar's `⌨` turned out to be a hairline outline on macOS) — and a
 * dependency added for a component nothing renders is one nobody maintains.
 * `size="square"` is what those icon buttons take.
 *
 * **`border-0 bg-transparent` in the base is the one addition**, and it is here
 * rather than in `styles.css`'s reset on purpose. The registry assumes preflight
 * has already stripped every `<button>` in the document; this app's reset
 * deliberately has not, because a global `button { background: none; border: 0 }`
 * would flatten every chrome button no swap has reached yet into bare text. So
 * the neutralising happens per component. Watched: without it the `link`
 * variant's "Have an account? Register" rendered inside the platform's grey
 * button box, on the signed-out page, 2026-08-09. `tailwind-merge` is what lets
 * the `outline` variant put its 1px border straight back.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 border-0 bg-transparent rounded-md text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline:
          'border-input bg-background hover:bg-accent hover:text-accent-foreground border shadow-sm',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        square: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants>,
    Hintable,
    Factable {}

/**
 * A chrome button.
 *
 * Chrome only, and that is a rule rather than a habit: nothing inside
 * `[data-grid]` may carry a utility class, because the scoped reset in
 * `styles.css` stops at that element and the widths in `table-frame.ts` were
 * measured against what a browser draws with no stylesheet at all.
 *
 * `type` is left to the caller and deliberately not defaulted to `"button"`.
 * The auth form's submit is a `<Button type="submit">`, and a default that
 * silently made every button non-submitting would break exactly the one place
 * a form needs one.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref,
) {
  return (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
});
