import { Link } from '@tanstack/react-router'
import { AlgorandLogo } from '@/components/Brand'

/**
 * Branded 404, wired as the root route's `notFoundComponent` (covers unmatched
 * URLs and `notFound()` thrown by loaders). Implements the "Not Found" screen
 * from the Algorand Foundation design system: an oversized "4 [Algorand mark] 4"
 * lockup over a headline, subcopy, and two pill actions. Renders standalone (the
 * route mounts it outside the app Layout), centered full-height. Inside the root
 * document, so providers + router context are available and `Link` works.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-7 py-14 text-center text-foreground">
      <div className="flex max-w-[560px] flex-col items-center">
        {/* 4 · Algorand mark · 4 — the "0" is the brand tile */}
        <div className="flex items-center gap-[18px]">
          <span className="font-display text-[132px] font-bold leading-[0.9] tracking-[-0.04em]">4</span>
          <span className="inline-flex size-[118px] items-center justify-center rounded-lg bg-primary/10">
            <AlgorandLogo className="size-[68px] text-primary" />
          </span>
          <span className="font-display text-[132px] font-bold leading-[0.9] tracking-[-0.04em]">4</span>
        </div>

        <h1 className="mt-7 font-display text-[38px] font-bold leading-[1.08] tracking-[-0.01em]">
          {"We can't find that page"}
        </h1>
        <p className="mt-3.5 max-w-[46ch] text-[17px] leading-[1.55] text-muted-foreground">
          The link you followed may be broken, or the page may have moved.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/vote"
            className="rounded-full bg-primary px-[22px] py-3 text-[15px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to voting periods
          </Link>
          <Link
            to="/docs"
            className="rounded-full border border-border px-[22px] py-[11px] text-[15px] font-semibold text-foreground transition-colors hover:border-foreground/40"
          >
            Read the docs
          </Link>
        </div>
      </div>
    </main>
  )
}
