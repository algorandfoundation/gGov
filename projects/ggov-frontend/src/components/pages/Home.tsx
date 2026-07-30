import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { Droplets, History } from 'lucide-react'
import type { GGovPeriod } from 'ggov-sdk'
import { usePeriods, usePeriodBody, type PeriodWithId } from '@/hooks/queries'
import { periodStatus, formatDateRange, type PeriodStatus } from '@/utils/time'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
  { n: '01', title: 'One block, one vote', body: 'Your weight equals the blocks you produced.' },
  { n: '02', title: '3M-block window', body: 'Each window spans 3M blocks, advancing 1M at a time.' },
  { n: '03', title: 'No opt-in required', body: 'No ALGO committed — just vote.' },
  { n: '04', title: 'Pooled stake counts', body: 'Pool & liquid stakers vote their share pro-rata.' },
]

/**
 * gGov homepage — a focused single-column ballot. One featured period (the active
 * one, else the soonest upcoming, else the latest closed) leads with a progress
 * dial and CTA; the rest collapse into a quiet "Other periods" list (with a link
 * through to the full list), then a "How Governance works" explainer and a quiet
 * pointer to the legacy (periods 1–15) portal.
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

      <section className="mx-auto w-full max-w-[860px] bg-muted/40 p-7">
        <h2 className="mb-4 text-center font-display text-base font-bold">How Governance works</h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n}>
              <div className="font-display text-sm font-bold text-algo-blue dark:text-algo-teal">{s.n}</div>
              <div className="mt-1 text-[13.5px] font-semibold">{s.title}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{s.body}</div>
            </div>
          ))}
        </div>
        <div className="mt-6 flex justify-center">
          <Button asChild variant="secondary">
            <Link to="/docs">Read the Governance docs</Link>
          </Button>
        </div>
      </section>

      {/* Pooled voting is invisible to a staker who doesn't know it exists — their
          power sits with the pool's escrows, not their own account — so this is
          unconditional rather than gated on wallet state. Sits after the "how it
          works" primer: it reads as a follow-on for stakers who just learned the
          basics, rather than interrupting the period list with an edge case. */}
      <section className="mx-auto w-full max-w-[680px]">
        <div className="flex items-start gap-4 rounded-lg border border-algo-teal/20 bg-algo-teal/10 px-5 py-[18px]">
          <span className="grid size-[42px] shrink-0 place-items-center rounded-full bg-card text-algo-teal">
            <Droplets className="size-[21px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-[15.5px] font-bold">Staking through a pool? You vote here too.</div>
            <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
              If you hold xALGO or tALGO, or stake with a Reti pool, your share of the pool's voting power is yours to
              cast.
            </p>
            <div className="mt-2.5 text-right">
              <Link
                to="/docs/pooled-voting"
                className="text-[13px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
              >
                How it works →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[760px] pb-10">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-[18px]">
          <div className="flex w-full items-center gap-[18px] sm:flex-1">
            <History className="size-[22px] shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-display text-[15px] font-bold">Periods 1–15 · Legacy governance</div>
              <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
                The 2021–2025 ALGO-commitment rounds ran on a separate portal. Results and historical votes remain
                available there.
              </p>
            </div>
          </div>
          <a
            href="https://governance.algorand.foundation/"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 whitespace-nowrap text-[13.5px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
          >
            Open legacy portal →
          </a>
        </div>
      </section>
    </div>
  )
}
