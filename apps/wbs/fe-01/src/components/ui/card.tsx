import { type HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * A panel with a border and a shadow, for chrome that stands apart from the
 * page rather than flowing down it.
 *
 * The auth screen is what it was vendored for: a signed-out page whose only
 * content is one form reads as unfinished when that form is loose on a white
 * background.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('bg-card text-card-foreground rounded-lg border shadow-sm', className)}
      {...props}
    />
  );
}

/** The card's heading block. */
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 p-6 pb-0', className)} {...props} />;
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /**
   * Which heading this is. `h2` by default, because a card is a section of a
   * page that already has an `h1`.
   *
   * A prop rather than a fixed tag: a card nested inside a section that already
   * has an `h2` needs an `h3`, and a document whose levels skip is a document a
   * screen reader's outline lies about.
   */
  as?: 'h2' | 'h3' | 'h4';
}

/**
 * The card's title, and a real heading.
 *
 * The registry ships this as a `div`, which is why it is worth a note. The auth
 * screen's title was an `<h2>` before this change and rendering it as a `div`
 * took the heading out of the page's outline — nothing on the signed-out page
 * was a heading below `WBS tool v2` any more. Both reviews caught it; the tests
 * did not, because none of them queried by role. `auth-form.test.tsx` does now,
 * and was watched failing against the `div`.
 */
export function CardTitle({ className, as: Heading = 'h2', ...props }: CardTitleProps) {
  return <Heading className={cn('text-lg leading-none font-semibold', className)} {...props} />;
}

/** The sentence under the title. */
export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-muted-foreground text-sm', className)} {...props} />;
}

/** The card's body. */
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6', className)} {...props} />;
}

/** The card's actions, along the bottom. */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-6 pt-0', className)} {...props} />;
}
