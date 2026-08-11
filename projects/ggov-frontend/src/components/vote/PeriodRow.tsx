import { Link } from '@tanstack/react-router'
import type { GGovPeriod } from 'ggov-sdk'
import { ClampedMarkdown } from '@/components/ui/clamped-markdown'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { usePeriodBody } from '@/hooks/queries'
import { periodStatus, formatDateRange } from '@/utils/time'
import { toPlainText } from '@/utils/format'
import { periodCountLabel } from '@/utils/periodTerms'
import { cn } from '@/lib/utils'

/** Shared desktop column template for the periods table header + rows. The
 *  ballot column is wide enough for "2 elections", the longest label
 *  {@link periodCountLabel} produces at realistic counts. */
export const PERIOD_ROW_GRID = 'grid-cols-[50px_1fr_150px_118px_110px]'

interface Props {
  periodId: number
  period: GGovPeriod
}

/**
 * One period in the "All periods" list. A table-like grid row on desktop, a
 * stacked card below `md`. Whole row links to the period detail page.
 */
export default function PeriodRow({ periodId, period }: Props) {
  const { data: body } = usePeriodBody(periodId)
  const status = periodStatus(period.votingStart, period.votingEnd)
  // The list mixes standard periods with elections, so a bare number under one
  // heading would mean a different thing per row — carry the noun in the cell.
  const countLabel = periodCountLabel(period.topics.length, body?.elect)

  return (
    <Link
      to="/vote/period/$periodId"
      params={{ periodId: String(periodId) }}
      className="block rounded-md border border-border bg-card transition-colors hover:border-foreground/30"
    >
      {/* Desktop grid row */}
      <div className={cn('hidden items-center gap-3.5 px-4 py-3 md:grid', PERIOD_ROW_GRID)}>
        <span className="font-mono text-[13px] text-muted-foreground">#{periodId}</span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{body?.title ?? `Period ${periodId}`}</div>
          {body?.body && <div className="truncate text-[13px] text-muted-foreground">{toPlainText(body.body)}</div>}
        </div>
        <span className="text-[13px]">{formatDateRange(period.votingStart, period.votingEnd)}</span>
        <span className="text-[13px]">{countLabel}</span>
        <span className="justify-self-end">
          <PeriodStatusBadge status={status} />
        </span>
      </div>

      {/* Mobile stacked card */}
      <div className="p-4 md:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PeriodStatusBadge status={status} />
            <span>Period {periodId}</span>
          </div>
          <span className="text-xs text-muted-foreground">{countLabel}</span>
        </div>
        <h4 className="mt-2.5 text-base leading-[1.15]">{body?.title ?? `Period ${periodId}`}</h4>
        {body?.body && (
          <ClampedMarkdown fadeFrom="from-card" className="mt-1.5 text-[13px] text-muted-foreground">
            {body.body}
          </ClampedMarkdown>
        )}
        <div className="mt-2.5 text-xs text-muted-foreground">
          {formatDateRange(period.votingStart, period.votingEnd)}
        </div>
      </div>
    </Link>
  )
}
