import { Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import type { GGovPeriod } from 'ggov-sdk'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import { usePeriodBody, useCommittee, toBase64Url } from '@/hooks/queries'
import { formatMonthDay, formatMonthDayYear, daysUntil } from '@/utils/time'
import { formatBlockRange, toPlainText } from '@/utils/format'
import { periodTurnoutPct } from '@/lib/turnout'

interface Props {
  periodId: number
  period: GGovPeriod
}

/**
 * Split hero card for the single active voting period: meta + title + clipped
 * description + key dates on the left, a countdown / turnout meter / CTA on the right.
 */
export default function ActivePeriodHero({ periodId, period }: Props) {
  const { activeAddress } = useWallet()
  const { data: body } = usePeriodBody(periodId)
  const committeeId = toBase64Url(period.committeeId)
  const { data: committee } = useCommittee(committeeId)

  const turnoutPct = periodTurnoutPct(period, committee?.totalVotes)
  const closesInDays = daysUntil(period.votingEnd)
  const topicCount = period.topics.length

  return (
    <div className="mt-6 flex flex-col overflow-hidden rounded-xl border border-border border-t-[3px] border-t-algo-blue bg-card shadow-sm dark:border-t-algo-teal md:flex-row">
      {/* Left: meta, title, description, facts */}
      <div className="min-w-0 flex-1 p-6 md:px-[26px]">
        <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <Badge className="border-transparent bg-algo-teal text-[#001324]">Active</Badge>
          <span>Period {periodId}</span>
          <span aria-hidden>·</span>
          <span>{topicCount} topic{topicCount !== 1 ? 's' : ''}</span>
        </div>
        <h2 className="mt-3.5 text-[27px] leading-[1.08]">{body?.title ?? `Period ${periodId}`}</h2>
        {body?.body && (
          <p className="mt-2.5 line-clamp-2 text-[15px] leading-[1.5] text-muted-foreground">
            {toPlainText(body.body)}
          </p>
        )}
        <div className="mt-[18px] flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <span><span className="text-muted-foreground">Opened</span> {formatMonthDay(period.votingStart)}</span>
          <span><span className="text-muted-foreground">Closes</span> {formatMonthDayYear(period.votingEnd)}</span>
          {committee && (
            <span><span className="text-muted-foreground">Blocks</span> {formatBlockRange(committee.periodStart, committee.periodEnd)}</span>
          )}
        </div>
      </div>

      {/* Right rail: countdown, turnout meter, CTA */}
      <div className="flex w-full flex-none flex-col gap-4 border-t border-border bg-muted/40 p-6 md:w-[296px] md:border-l md:border-t-0">
        {closesInDays >= 0 && (
          <div className="text-[13px] text-muted-foreground">
            Closes in <strong className="font-display text-lg text-foreground">{closesInDays} day{closesInDays !== 1 ? 's' : ''}</strong>
          </div>
        )}
        <div>
          <div className="mb-2 flex justify-between text-xs text-muted-foreground">
            <span>Votes cast</span>
            <span className="font-semibold text-foreground">{turnoutPct != null ? `${turnoutPct}%` : '—'}</span>
          </div>
          <ProgressBar value={turnoutPct ?? 0} tone="sky" height={8} />
        </div>
        <Button asChild className="w-full">
          <Link to="/vote/period/$periodId" params={{ periodId: String(periodId) }}>Cast your vote</Link>
        </Button>
      </div>
    </div>
  )
}
