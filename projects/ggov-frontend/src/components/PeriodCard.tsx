import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { MarkdownContent } from '@/components/ui/markdown-content'
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
  const [expanded, setExpanded] = useState(false)

  // Roughly the collapsed height (~3 lines); short descriptions don't need a toggle.
  const isLong = !!body?.body && (body.body.length > 140 || body.body.split('\n').length > 3)

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
            {body?.body && (
              <div>
                <div className={!isLong || expanded ? undefined : 'relative max-h-[4.5rem] overflow-hidden'}>
                  <MarkdownContent>{body.body}</MarkdownContent>
                  {isLong && !expanded && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
                  )}
                </div>
                {isLong && (
                  <button
                    type="button"
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setExpanded((v) => !v)
                    }}
                  >
                    {expanded ? 'Show less' : 'Show more…'}
                  </button>
                )}
              </div>
            )}
            <div>Voting: {formatTimestamp(period.votingStart)} — {formatTimestamp(period.votingEnd)}</div>
            <div>{period.topics.length} topic{period.topics.length !== 1 ? 's' : ''}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
