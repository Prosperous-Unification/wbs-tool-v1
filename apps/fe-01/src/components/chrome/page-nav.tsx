import { Link } from '@tanstack/react-router';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The two pages of the signed-in region, and a mark on the one that is showing.
 *
 * Real links rather than buttons that navigate: an address is the whole reason
 * `docs/adr/0004-the-signed-in-region-gets-a-router.md` exists, and a `<button>`
 * cannot be middle-clicked, copied, or opened in a second tab.
 *
 * `aria-current="page"` is the router's own doing — `Link` stamps it on the
 * active one, and that is the whole reason these are `Link`s rather than
 * anchors with an `href`. There is deliberately **no** `activeOptions={{ exact:
 * true }}` on the plan's link: `/` and `/directory` are siblings under the root
 * route rather than parent and child, so `Link` never reads the plan as active
 * on the directory. The option was written, and removing it was watched
 * changing nothing — a guard whose failure cannot be observed is a claim, so it
 * is not here. `app-router.test.tsx`'s `marks only the page that is showing`
 * asserts both ends of the mark and was watched failing against a plain anchor.
 */
export function PageNav() {
  // `text-foreground` because these are `<a href>`s: `buttonVariants` names no
  // colour for `ghost` at rest, and `styles.css`'s reset gives `color: inherit`
  // to form controls and not to links — so each of these kept whatever the user
  // agent paints an unstyled link, which is not a token and never was.
  //
  // Which colour that is depends on `color-scheme`, and both were measured.
  // With none declared it was `-webkit-link` blue, `rgb(0, 0, 238)`, at 2.14:1
  // against the dark `--background` — all but gone. With `color-scheme: dark`
  // in place it is `rgb(158, 158, 255)` at 8.0:1, which is legible and still
  // wrong: a periwinkle in a header whose every other word is `--foreground`.
  // So this is not a contrast fix and `dark-mode.spec.ts` does not assert it as
  // one — it asserts the link is the palette's own ink, which is a claim that
  // can fail. Both numbers: `openspec/changes/dark-mode/verify.md`.
  const shape = cn(
    buttonVariants({ variant: 'ghost', size: 'sm' }),
    'text-foreground shrink-0 max-md:min-h-11',
  );
  const marked = { className: 'bg-accent text-accent-foreground' };
  return (
    <nav aria-label="Pages" className="flex shrink-0 items-center gap-1">
      <Link to="/" className={shape} activeProps={marked}>
        Plan
      </Link>
      <Link to="/directory" className={shape} activeProps={marked}>
        Directory
      </Link>
    </nav>
  );
}
