import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Sparkles,
  Network,
  Share2,
  Gauge,
  Layers,
  ArrowRight,
  Cpu,
  Vote,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { usePeriods, useCommittee, useAllDelegations, usePeriodBody, toBase64Url } from '@/hooks/queries'
import { periodStatus, formatTimestamp } from '@/utils/time'
import { cn } from '@/lib/utils'

/** Live ticking remainder until `targetUnixSeconds`, broken into d/h/m/s. */
function useCountdown(targetUnixSeconds: number | undefined) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    // No target → no ticking, so the page doesn't re-render every second
    // when there's nothing to count down to.
    if (targetUnixSeconds === undefined) return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [targetUnixSeconds])

  if (targetUnixSeconds === undefined) return null
  const remaining = Math.max(0, targetUnixSeconds - now)
  return {
    days: Math.floor(remaining / 86400),
    hours: Math.floor((remaining % 86400) / 3600),
    minutes: Math.floor((remaining % 3600) / 60),
    seconds: remaining % 60,
    done: remaining === 0,
  }
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return n.toLocaleString()
}

const HOW_IT_WORKS = [
  {
    icon: Cpu,
    title: 'Produce blocks',
    body: 'Voting power comes from consensus: run a participation node and produce blocks over the monitoring window to earn your seat on the committee.',
  },
  {
    icon: Vote,
    title: 'Vote',
    body: 'Review the topics proposed by the Foundation, then spread your voting power across the options during the voting window.',
  },
  {
    icon: Users,
    title: 'Delegate',
    body: "Short on time to follow every topic? Delegate your voting power to an account you trust to vote on your behalf.",
  },
]

/** Decorative, on-brand "block production" motif — pure CSS/SVG, no external asset. */
function HeroVisual() {
  return (
    <div className="relative isolate hidden aspect-square w-full max-w-md items-center justify-center md:flex">
      <div className="absolute inset-0 -z-10 rounded-full bg-algo-teal/15 blur-3xl" aria-hidden />
      <svg viewBox="0 0 200 200" className="w-full" role="img" aria-label="Blocks being produced in a chain">
        <defs>
          <linearGradient id="hero-teal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--algo-teal)" />
            <stop offset="100%" stopColor="var(--algo-blue)" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} style={{ transformOrigin: 'center', animation: `floaty 6s ease-in-out ${i * 0.4}s infinite` }}>
            <rect
              x={40 + i * 26}
              y={120 - i * 26}
              width="46"
              height="46"
              rx="10"
              fill="url(#hero-teal)"
              opacity={0.35 + i * 0.2}
            />
          </g>
        ))}
        <path
          d="M64 150 90 124 116 98 142 72"
          stroke="var(--algo-blue)"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
      </svg>
      <style>{`@keyframes floaty { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }`}</style>
    </div>
  )
}

interface StatCardProps {
  label: string
  className?: string
  children: ReactNode
  icon?: ReactNode
  footnote?: string
}

function StatCard({ label, className, children, icon, footnote }: StatCardProps) {
  return (
    <div className={cn('flex flex-col justify-between rounded-xl border bg-card p-6', className)}>
      {icon && <div className="mb-4">{icon}</div>}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</p>
        <div className="mt-1">{children}</div>
        {footnote && <p className="mt-2 text-xs opacity-60">{footnote}</p>}
      </div>
    </div>
  )
}

export default function Home() {
  const { data: periods = [], isLoading: periodsLoading } = usePeriods()
  const { data: delegations, isLoading: delegationsLoading } = useAllDelegations()

  // Voters only ever see periods the operator has marked ready, latest first.
  const readyPeriods = useMemo(
    () => periods.filter((p) => p.ready).sort((a, b) => b.id - a.id),
    [periods],
  )
  const activePeriod = useMemo(
    () => readyPeriods.find((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'active'),
    [readyPeriods],
  )
  // The soonest-to-open upcoming period — shown when nothing is currently active.
  const upcomingPeriod = useMemo(
    () =>
      readyPeriods
        .filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'upcoming')
        .sort((a, b) => a.period.votingStart - b.period.votingStart)[0],
    [readyPeriods],
  )
  // The most recently closed period — the final fallback so the dashboard still
  // shows real committee numbers when nothing is active or upcoming.
  const endedPeriod = useMemo(
    () =>
      readyPeriods
        .filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'ended')
        .sort((a, b) => b.period.votingEnd - a.period.votingEnd)[0],
    [readyPeriods],
  )
  // Prefer active → next upcoming → most recent ended (with a hard fallback to
  // the latest ready period for any unforeseen status).
  const displayPeriod = activePeriod ?? upcomingPeriod ?? endedPeriod ?? readyPeriods[0]
  const displayStatus = displayPeriod
    ? periodStatus(displayPeriod.period.votingStart, displayPeriod.period.votingEnd)
    : undefined

  const committeeIdB64 = useMemo(() => {
    const id = displayPeriod?.period.committeeId
    return id && id.length > 0 ? toBase64Url(id) : undefined
  }, [displayPeriod])
  const { data: committee, isLoading: committeeLoading } = useCommittee(committeeIdB64)
  const { data: displayPeriodBody, isLoading: periodBodyLoading } = usePeriodBody(displayPeriod?.id ?? -1)

  // Count down to the window's close while active, or to its open while upcoming.
  const countdownTarget =
    displayStatus === 'active'
      ? displayPeriod!.period.votingEnd
      : displayStatus === 'upcoming'
        ? displayPeriod!.period.votingStart
        : undefined
  const countdown = useCountdown(countdownTarget)

  const progressPct = useMemo(() => {
    if (displayStatus === 'ended') return 100
    if (displayStatus !== 'active') return 0
    const { votingStart, votingEnd } = displayPeriod!.period
    const now = Math.floor(Date.now() / 1000)
    if (votingEnd <= votingStart) return 0
    return Math.min(100, Math.max(0, ((now - votingStart) / (votingEnd - votingStart)) * 100))
  }, [displayPeriod, displayStatus, countdown])

  // Headline + time-card label track which period the dashboard is showing.
  const dashboardHeading =
    displayStatus === 'upcoming'
      ? 'Upcoming period'
      : displayStatus === 'ended'
        ? 'Most recent period'
        : 'Active period dashboard'
  const timeLabel =
    displayStatus === 'upcoming'
      ? 'Voting opens in'
      : displayStatus === 'ended'
        ? 'Voting window'
        : 'Time remaining in period'

  const monitoringRounds = committee ? committee.periodEnd - committee.periodStart : undefined

  return (
    <div className="mx-auto max-w-6xl space-y-20 pb-12">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="grid items-center gap-10 pt-6 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-algo-teal/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-info-foreground">
            <Sparkles className="size-3.5" />
            {periodsLoading ? (
              <Skeleton className="h-3 w-28" />
            ) : displayPeriod ? (
              `Governance period ${displayPeriod.id}`
            ) : (
              'Algorand consensus governance'
            )}
          </span>
          <h1 className="text-5xl leading-[1.05] md:text-6xl">
            Governance power to the <span className="text-algo-teal">builders.</span>
          </h1>
          <p className="max-w-lg text-lg text-muted-foreground">
            Shape the future of the Algorand ecosystem. Voting power comes from block production over the
            consensus monitoring window, not from locked stake.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/vote">
                View periods
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#how-it-works">How it works</a>
            </Button>
          </div>
        </div>
        <div className="flex justify-center">
          <HeroVisual />
        </div>
      </section>

      {/* ── Active period dashboard (bento) ──────────────────────────────── */}
      <section className="space-y-6">
        <div className="space-y-2">
          <h2 className="text-3xl">{dashboardHeading}</h2>
          <div className="h-1 w-24 rounded-full bg-algo-teal" />
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {/* Time remaining */}
          <div className="col-span-2 flex flex-col justify-between rounded-xl border bg-card p-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {timeLabel}
              </p>
              {periodsLoading ? (
                <Skeleton className="mt-3 h-12 w-64" />
              ) : countdown ? (
                <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1 font-display">
                  {([
                    [countdown.days, 'days'],
                    [countdown.hours, 'hrs'],
                    [countdown.minutes, 'min'],
                    [countdown.seconds, 'sec'],
                  ] as const).map(([value, unit]) => (
                    <div key={unit} className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold tabular-nums sm:text-4xl md:text-5xl">
                        {String(value).padStart(2, '0')}
                      </span>
                      <span className="text-xs font-semibold uppercase text-muted-foreground">{unit}</span>
                    </div>
                  ))}
                </div>
              ) : displayStatus === 'ended' ? (
                <p className="mt-3 font-display text-2xl font-semibold">
                  Closed {formatTimestamp(displayPeriod!.period.votingEnd)}
                </p>
              ) : (
                <p className="mt-3 text-2xl text-muted-foreground">No voting period</p>
              )}
            </div>
            <div className="mt-6 h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-algo-teal transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>

          {/* Voting committee size — accent (blue) */}
          <StatCard
            label="Voting committee size"
            className="col-span-1 border-transparent bg-primary text-primary-foreground"
            icon={<Network className="size-7" />}
          >
            {committeeLoading || periodsLoading ? (
              <Skeleton className="h-8 w-20 bg-primary-foreground/20" />
            ) : (
              <p className="font-display text-3xl font-bold">
                {committee ? committee.totalMembers.toLocaleString() : '-'}
              </p>
            )}
          </StatCard>

          {/* Active delegations — voting power handed to a delegate */}
          <StatCard
            label="Active delegations"
            className="col-span-1 border-transparent bg-algo-teal/15 text-info-foreground"
            icon={<Share2 className="size-7" />}
          >
            {delegationsLoading ? (
              <Skeleton className="h-8 w-20 bg-foreground/10" />
            ) : (
              <p className="font-display text-3xl font-bold">
                {delegations ? formatCompact(delegations.size) : '-'}
              </p>
            )}
          </StatCard>

          {/* Total voting power (real — replaces the design's duplicate governor count) */}
          <StatCard label="Total voting power" className="col-span-1" icon={<Gauge className="size-6 text-algo-teal" />}>
            {committeeLoading || periodsLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <p className="font-display text-2xl font-bold">
                {committee ? formatCompact(committee.totalVotes) : '-'}
              </p>
            )}
          </StatCard>

          {/* Monitoring window */}
          <StatCard label="Monitoring window" className="col-span-1" icon={<Layers className="size-6 text-algo-teal" />}>
            {committeeLoading || periodsLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <p className="font-display text-2xl font-bold">
                {monitoringRounds !== undefined ? `${formatCompact(monitoringRounds)} rounds` : '-'}
              </p>
            )}
          </StatCard>

          {/* Current period title */}
          <div className="col-span-2 flex items-center justify-between gap-4 rounded-xl border bg-card p-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {displayPeriod ? `Governance period ${displayPeriod.id}` : 'Governance period'}
              </p>
              {periodsLoading || periodBodyLoading ? (
                <Skeleton className="mt-1 h-6 w-48" />
              ) : (
                <p className="mt-1 truncate font-display text-xl font-semibold">
                  {displayPeriodBody?.title ?? (displayPeriod ? `Period ${displayPeriod.id}` : 'No active voting period')}
                </p>
              )}
            </div>
            {displayPeriod && (
              <Button asChild variant="secondary" size="sm">
                <Link to={`/vote/period/${displayPeriod.id}`}>View period</Link>
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* ── How governance works ─────────────────────────────────────────── */}
      <section id="how-it-works" className="space-y-10 scroll-mt-20">
        <div className="mx-auto max-w-2xl space-y-3 text-center">
          <h2 className="text-4xl">How governance works</h2>
          <p className="text-muted-foreground">
            Voting power is earned through consistent block production over the consensus monitoring window, not
            from locked stake. Cast it yourself, or delegate it to an account you trust.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {HOW_IT_WORKS.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="flex flex-col gap-3">
              <div className="flex size-12 items-center justify-center rounded-lg bg-algo-teal/10 text-algo-teal">
                <Icon className="size-6" />
              </div>
              <h3 className="text-lg font-semibold">
                {i + 1}. {title}
              </h3>
              <p className="text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
        <div className="flex justify-center">
          <Link
            to="/docs"
            className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline dark:text-algo-teal"
          >
            Read documentation
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      {/* ── Closing CTA ──────────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-col items-center gap-6 rounded-2xl bg-foreground px-6 py-14 text-center text-background">
          <h2 className="max-w-3xl text-4xl">Ready to shape the future of Algorand?</h2>
          <p className="max-w-xl text-lg opacity-80">
            Join the block producers steering the ecosystem, vote on the topics that matter, or delegate your
            power to an account you trust.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/vote">
                Launch governance app
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
