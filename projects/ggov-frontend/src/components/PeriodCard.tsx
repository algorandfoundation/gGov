import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
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
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {body?.title}
            </CardTitle>
            <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-1 text-sm text-muted-foreground">
            {body?.body && <div className="line-clamp-2">{body.body}</div>}
            <div>Voting: {formatTimestamp(period.votingStart)} — {formatTimestamp(period.votingEnd)}</div>
            <div>{period.topics.length} topic{period.topics.length !== 1 ? 's' : ''}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
