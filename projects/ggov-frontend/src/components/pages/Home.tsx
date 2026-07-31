import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import type { GGovPeriod } from 'ggov-sdk'
import { usePeriods, usePeriodBody, type PeriodWithId } from '@/hooks/queries'
import { periodStatus, formatDateRange, type PeriodStatus } from '@/utils/time'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import FocusedPeriodHero from '@/components/vote/FocusedPeriodHero'
import { PeriodStatusTag } from '@/components/vote/PeriodRow'

/** Compact row in the "Other periods" list — links to the period detail page. */
function OtherPeriodRow({ periodId, period }: { periodId: number; period: GGovPeriod }) {
  const { data: body } = usePeriodBody(periodId)
  const status = periodStatus(period.votingStart, period.votingEnd)
  return (
    <Link
      to="/vote/period/$periodId"
      params={{ periodId: String(periodId) }}
      className="group flex items-center gap-3.5 border-t border-border py-3.5"
    >
      <PeriodStatusTag status={status} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold transition-colors group-hover:text-algo-blue dark:group-hover:text-algo-teal">
        {body?.title ?? `Period ${periodId}`}
      </span>
      <span className="whitespace-nowrap text-[13px] text-muted-foreground">
        {formatDateRange(period.votingStart, period.votingEnd)}
      </span>
    </Link>
  )
}

const STEPS = [
  {
    n: '01',
    title: 'One block, one vote',
    body: 'Your weight equals the blocks you produced over the voting committee window.',
  },
  { n: '02', title: '3M-block window', body: 'Committee windows span 3M blocks, advancing 1M at a time.' },
  {
    n: '03',
    title: 'Pooled stake counts',
    body: 'Hold xALGO or tALGO, or stake with a Réti pool? Vote your prorated share.',
    // The one step that isn't about producing blocks yourself — third rather than
    // last, so it reads as part of "who can vote" instead of an afterthought. It
    // carries the only teal in the grid: tinted cell, teal number, POOLED pill.
    pooled: true,
  },
  { n: '04', title: 'No opt-in required', body: "Nothing to register or commit. If you're eligible, come and vote." },
]

/**
 * gGov homepage — a focused single-column ballot. One featured period (the active
 * one, else the soonest upcoming, else the latest closed) leads with a progress
 * dial and CTA; the rest collapse into a quiet "Other periods" list (with a link
 * through to the full list), and finally one card carrying the "How Governance
 * works" primer over a legacy-portal (periods 1–15) footer strip. Pooled voting
 * gets no callout of its own here — step 03 of the primer carries it.
 */
export default function Home() {
  const { data: periods = [], isLoading } = usePeriods()

  // Voters only see periods the operator has marked ready, latest first.
  const readyPeriods = useMemo(() => periods.filter((p) => p.ready).sort((a, b) => b.id - a.id), [periods])

  // Featured period: the active one wins; else the soonest-to-open upcoming; else
  // the most recent closed period — so the hero is never empty when any exist.
  const featured: PeriodWithId | undefined = useMemo(() => {
    const inBucket = (s: PeriodStatus) =>
      readyPeriods.filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === s)
    const active = inBucket('active')[0]
    const upcoming = [...inBucket('upcoming')].sort((a, b) => a.period.votingStart - b.period.votingStart)[0]
    const ended = inBucket('ended')[0]
    return active ?? upcoming ?? ended
  }, [readyPeriods])

  const others = useMemo(() => readyPeriods.filter((p) => p.id !== featured?.id), [readyPeriods, featured])

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-[680px] flex-col items-center gap-4 py-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="size-[184px] rounded-full" />
        <Skeleton className="h-11 w-[280px]" />
      </div>
    )
  }

  if (readyPeriods.length === 0 || !featured) {
    return <p className="py-10 text-center text-muted-foreground">No voting periods found.</p>
  }

  const featuredStatus = periodStatus(featured.period.votingStart, featured.period.votingEnd)

  return (
    <div className="flex flex-col gap-14 py-2">
      <FocusedPeriodHero periodId={featured.id} period={featured.period} status={featuredStatus} />

      {others.length > 0 && (
        <section className="mx-auto w-full max-w-[680px]">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-muted-foreground">Other periods</h2>
            <Link
              to="/vote"
              className="text-[13px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
            >
              View all {readyPeriods.length} →
            </Link>
          </div>
          <div className="flex flex-col">
            {others.slice(0, 3).map((p) => (
              <OtherPeriodRow key={p.id} periodId={p.id} period={p.period} />
            ))}
          </div>
        </section>
      )}

      {/* One card for the page's two closing blocks — the "how it works" primer and
          the legacy-portal pointer — which used to be separate stacked sections. */}
      <section className="mx-auto w-full max-w-[860px] pb-10">
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-2 border-b border-border px-[18px] py-4 md:flex-row md:items-end md:justify-between md:gap-5 md:px-6 md:pb-[18px] md:pt-5">
            <div>
              <Eyebrow>The basics</Eyebrow>
              <h2 className="mt-2 font-display text-lg font-bold md:text-[21px]">How Governance works</h2>
            </div>
            <Link
              to="/docs"
              className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
            >
              Read the Governance docs →
            </Link>
          </div>

          {/* Two states only, matching the design: stacked, or the full 4-up row.
              An intermediate 2-up would need its own hairline rules for cells that
              start a row, and buys nothing at these copy lengths. */}
          <div className="grid grid-cols-1 md:grid-cols-4">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className={cn(
                  // Hairlines run *between* cells: above each while stacked, beside
                  // each once they sit in a row. The first cell has neither — the
                  // header's own bottom border already closes it off.
                  'border-t border-border px-[18px] py-[15px] first:border-t-0',
                  'md:border-l md:border-t-0 md:px-5 md:pb-5 md:pt-[18px] md:first:border-l-0',
                  s.pooled && 'bg-algo-teal/10',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-display text-sm font-bold',
                      s.pooled ? 'text-teal-strong' : 'text-algo-blue dark:text-algo-teal',
                    )}
                  >
                    {s.n}
                  </span>
                  {/* Stacked, the title shares the number's line to keep four steps
                      from dominating the page; in the grid it gets its own line.
                      Rendered twice rather than reordered — flex `order` can't move
                      it past the number on one axis and the pill on the other. */}
                  <span className="text-[14px] font-semibold md:hidden">{s.title}</span>
                  {s.pooled && (
                    <span className="rounded-full bg-card px-[7px] py-[2px] text-[9.5px] font-bold uppercase tracking-[0.06em] text-teal-strong">
                      Pooled
                    </span>
                  )}
                </div>
                <div className="mt-[7px] hidden text-[14.5px] font-semibold md:block">{s.title}</div>
                <div className="mt-1 text-[12.5px] leading-snug text-muted-foreground md:text-[13px]">{s.body}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1 border-t border-border bg-muted/50 px-[18px] py-3.5 md:flex-row md:items-center md:justify-between md:gap-5 md:px-6">
            <p className="text-[12.5px] leading-snug text-muted-foreground">
              Looking for <strong className="font-semibold text-foreground">Periods 1–15</strong>?{' '}
              <span className="hidden md:inline">The 2021–2025 ALGO-commitment rounds</span>
              <span className="md:hidden">Those rounds</span> ran on a separate portal.
            </p>
            <a
              href="https://governance.algorand.foundation/"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
            >
              Open legacy portal →
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
