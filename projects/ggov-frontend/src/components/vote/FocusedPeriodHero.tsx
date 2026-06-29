import { Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import type { GGovPeriod } from 'ggov-sdk'
import { Button } from '@/components/ui/button'
import { PeriodStatusTag } from '@/components/vote/PeriodRow'
import { usePeriodBody, useCommittee, useGovVotingPowers, useProducerRank, toBase64Url } from '@/hooks/queries'
import { periodTurnoutPct } from '@/lib/turnout'
import { daysUntil, formatMonthDayYear, type PeriodStatus } from '@/utils/time'
import { toPlainText } from '@/utils/format'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Circular progress dial (the hero centrepiece). `pct` (0–100) fills the arc
 * clockwise from the top; `center` is the large value and `label` the caption
 * beneath it. Uses the brand "sky" accent (blue in light, teal in dark).
 */
function Dial({ pct, center, label }: { pct: number; center: string; label: string }) {
  const r = 72
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return (
    <div className="relative size-[184px]" role="img" aria-label={`${center} — ${label}`}>
      <svg width="184" height="184" viewBox="0 0 184 184" className="-rotate-90">
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          strokeWidth={14}
          className="stroke-algo-blue/15 dark:stroke-algo-teal/25"
        />
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="stroke-algo-blue transition-[stroke-dashoffset] duration-700 ease-out dark:stroke-algo-teal"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[38px] font-bold leading-none tabular-nums text-foreground">{center}</span>
        <span className="mt-1.5 text-[11.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  )
}

interface Props {
  periodId: number
  period: GGovPeriod
  status: PeriodStatus
}

/**
 * Focused single-column hero for the featured period: status meta, title, clipped
 * description, the progress dial, a one-line schedule summary, and a primary CTA.
 * The dial reflects the period's phase — time left while active, time-to-open while
 * upcoming, and final turnout once ended.
 */
export default function FocusedPeriodHero({ periodId, period, status }: Props) {
  const { activeAddress } = useWallet()
  const { data: body } = usePeriodBody(periodId)
  const committeeId = toBase64Url(period.committeeId)
  const { data: committee } = useCommittee(committeeId)
  const powers = useGovVotingPowers(committeeId, activeAddress ? [activeAddress] : [])
  const power = activeAddress ? powers[activeAddress] : undefined
  const { data: rank } = useProducerRank(committeeId, activeAddress)

  const topicCount = period.topics.length
  const windowSecs = Math.max(1, period.votingEnd - period.votingStart)
  const nowSecs = Math.floor(Date.now() / 1000)

  // Dial + schedule line vary by phase. Active shows a countdown to close (the
  // arc is the share of the voting window still remaining, so it depletes as the
  // deadline nears); upcoming counts down to open; ended shows final turnout.
  let dialCenter: string
  let dialLabel: string
  let dialPct: number
  let scheduleLine: string
  if (status === 'active') {
    const daysLeft = Math.max(0, daysUntil(period.votingEnd))
    dialCenter = `${daysLeft}d`
    dialLabel = 'Time remaining'
    dialPct = Math.max(0, Math.min(100, ((period.votingEnd - nowSecs) / windowSecs) * 100))
    scheduleLine = `Closes ${formatMonthDayYear(period.votingEnd)} · ${plural(daysLeft, 'day')} left`
  } else if (status === 'upcoming') {
    const daysToOpen = Math.max(0, daysUntil(period.votingStart))
    dialCenter = `${daysToOpen}d`
    dialLabel = 'Until open'
    dialPct = 0
    scheduleLine = `Opens ${formatMonthDayYear(period.votingStart)} · in ${plural(daysToOpen, 'day')}`
  } else {
    const turnout = periodTurnoutPct(period, committee?.totalVotes)
    dialCenter = turnout != null ? `${turnout}%` : '—'
    dialLabel = 'Final turnout'
    dialPct = turnout ?? 0
    scheduleLine = `Closed ${formatMonthDayYear(period.votingEnd)}${turnout != null ? ` · ${turnout}% turnout` : ''}`
  }

  return (
    <section className="mx-auto max-w-[680px] text-center">
      <div className="inline-flex items-center gap-2.5 text-[13px] text-muted-foreground">
        <PeriodStatusTag status={status} />
        <span>
          Period {periodId} · {plural(topicCount, 'topic')}
        </span>
      </div>

      <h1 className="mt-4 text-balance font-display text-[40px] font-bold leading-[1.08] tracking-[-0.01em]">
        {body?.title ?? `Period ${periodId}`}
      </h1>
      {body?.body && (
        <p className="mt-4 line-clamp-4 w-full text-left text-base leading-[1.55] text-muted-foreground">
          {toPlainText(body.body)}
        </p>
      )}

      <div className="mt-9 flex justify-center">
        <Dial pct={dialPct} center={dialCenter} label={dialLabel} />
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{scheduleLine}</div>

      <div className="mt-7 flex flex-col items-center gap-3.5">
        {status === 'active' ? (
          <>
            <div className="w-full max-w-[280px]">
              <Button asChild size="lg" className="w-full">
                <Link to="/vote/period/$periodId" params={{ periodId: String(periodId) }}>
                  Cast your vote
                </Link>
              </Button>
            </div>
            {activeAddress
              ? power != null &&
                power > 0 && (
                  <div className="text-[13px] text-muted-foreground">
                    Your weight:{' '}
                    <strong className="font-bold text-algo-blue dark:text-algo-teal">{power.toLocaleString()}</strong>{' '}
                    votes
                    {rank ? ` · top ${rank.topPercentile}% of producers` : ''}
                  </div>
                )
              : null}
          </>
        ) : (
          <div className="w-full max-w-[280px]">
            <Button asChild size="lg" variant={status === 'ended' ? 'outline' : 'default'} className="w-full">
              <Link
                to={status === 'ended' ? '/vote/period/$periodId/results' : '/vote/period/$periodId'}
                params={{ periodId: String(periodId) }}
              >
                {status === 'ended' ? 'View full results' : 'View period'}
              </Link>
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
