import { Link } from '@tanstack/react-router'
import type { GGovPeriod } from 'ggov-sdk'
import { Badge } from '@/components/ui/badge'
import { ClampedMarkdown } from '@/components/ui/clamped-markdown'
import { usePeriodBody } from '@/hooks/queries'
import { periodStatus, formatDateRange, type PeriodStatus } from '@/utils/time'
import { toPlainText } from '@/utils/format'
import { cn } from '@/lib/utils'

/** Design status tones. "ended" reads as "Closed" — pass/reject outcome isn't
 *  derivable on-chain yet (TODO(FLAG): tone closed periods by result). */
const STATUS_BADGE: Record<PeriodStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'border-transparent bg-algo-teal text-[#001324]' },
  upcoming: { label: 'Upcoming', className: 'border-transparent bg-primary/10 text-primary dark:bg-algo-blue dark:text-white' },
  ended: { label: 'Closed', className: 'border-transparent bg-muted text-muted-foreground' },
}

export function PeriodStatusTag({ status, className }: { status: PeriodStatus; className?: string }) {
  const cfg = STATUS_BADGE[status]
  return <Badge className={cn(cfg.className, className)}>{cfg.label}</Badge>
}

/** Shared desktop column template for the periods table header + rows. */
export const PERIOD_ROW_GRID = 'grid-cols-[50px_1fr_150px_70px_110px]'

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
  const topicCount = period.topics.length

  return (
    <Link
      to="/vote/period/$periodId" params={{ periodId: String(periodId) }}
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
        <span className="text-[13px]">{topicCount}</span>
        <span className="justify-self-end"><PeriodStatusTag status={status} /></span>
      </div>

      {/* Mobile stacked card */}
      <div className="p-4 md:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PeriodStatusTag status={status} />
            <span>Period {periodId}</span>
          </div>
          <span className="text-xs text-muted-foreground">{topicCount} topic{topicCount !== 1 ? 's' : ''}</span>
        </div>
        <h4 className="mt-2.5 text-base leading-[1.15]">{body?.title ?? `Period ${periodId}`}</h4>
        {body?.body && (
          <ClampedMarkdown fadeFrom="from-card" className="mt-1.5 text-[13px] text-muted-foreground">{body.body}</ClampedMarkdown>
        )}
        <div className="mt-2.5 text-xs text-muted-foreground">{formatDateRange(period.votingStart, period.votingEnd)}</div>
      </div>
    </Link>
  )
}
