import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { ClampedMarkdown } from '@/components/ui/clamped-markdown'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { formatTimestamp } from '@/utils/time'
import { usePeriodBody } from '@/hooks/queries'
import type { GGovPeriod } from 'ggov-sdk'

interface Props {
  periodId: number
  period: GGovPeriod
  linkPrefix?: string
}

export default function PeriodCard({ periodId, period, linkPrefix = '/vote' }: Props) {
  const { data: body } = usePeriodBody(periodId)

  return (
    <Link to={`${linkPrefix}/period/${periodId}`}>
      <Card className="hover:border-foreground/20 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">
              {body?.title}
            </CardTitle>
            <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
          </div>
          <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground/80 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            <span className="shrink-0">{period.topics.length} topic{period.topics.length !== 1 ? 's' : ''}</span>
            <span className="order-first sm:order-none">{formatTimestamp(period.votingStart)} — {formatTimestamp(period.votingEnd)}</span>
          </div>
        </CardHeader>
        {body?.body && (
          <CardContent>
            <ClampedMarkdown fadeFrom="from-card" className="text-sm text-muted-foreground">{body.body}</ClampedMarkdown>
          </CardContent>
        )}
      </Card>
    </Link>
  )
}
