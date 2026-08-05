import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import type { GGovPeriod } from 'ggov-sdk'
import { usePeriods, useCommittees, usePeriodBody } from '@/hooks/queries'
import { periodCountLabel } from '@/utils/periodTerms'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { formatDateRangeUTC, formatTimestampUTC } from '@/utils/time'
import { periodFrozen } from '@/utils/periodEditing'
import { toBase64Url } from '@/hooks/queries'

interface PeriodTableRowProps {
  periodId: number
  period: GGovPeriod
  ready: boolean
  /** Committee rounds for this period's committee, pre-resolved by the table. */
  committeeRounds: string
}

/**
 * One period in the table. A component of its own so it can read the period *body*,
 * which the list query doesn't carry: the registry summary knows `numTopics` but neither
 * the title nor `elect`. TODO(perf): one body read per row. A batched period-body reader
 * on the SDK (alongside `getAllPeriodSummaries`) would collapse them into a single call.
 */
function PeriodTableRow({ periodId, period, ready, committeeRounds }: PeriodTableRowProps) {
  const { data: body } = usePeriodBody(periodId)

  return (
    <TableRow>
      <TableCell className="font-medium">{periodId}</TableCell>
      <TableCell className="text-sm">
        <Link
          to="/manage/period/$periodId"
          params={{ periodId: String(periodId) }}
          className="block max-w-[280px] truncate font-medium hover:underline"
        >
          {body?.title ?? <span className="font-normal text-muted-foreground">Untitled</span>}
        </Link>
      </TableCell>
      <TableCell className="text-sm">{committeeRounds}</TableCell>
      <TableCell className="text-sm">
        {/* Dates alone, to leave the title room; the exact window is a hover away. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">{formatDateRangeUTC(period.votingStart, period.votingEnd)}</span>
          </TooltipTrigger>
          <TooltipContent>
            {formatTimestampUTC(period.votingStart)} — {formatTimestampUTC(period.votingEnd)}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-sm">{periodCountLabel(period.topics.length, body?.elect)}</TableCell>
      <TableCell>
        <span
          className={
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
            (ready ? 'bg-success/15 text-success-strong' : 'bg-warning/15 text-warning-strong')
          }
        >
          {ready ? 'Ready' : 'Draft'}
        </span>
      </TableCell>
      <TableCell>
        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
      </TableCell>
      <TableCell className="text-right">
        {/* One button per row. A frozen period can never return to draft, so it offers View where the others offer Edit. */}
        {periodFrozen(period, ready) ? (
          <Link to="/manage/period/$periodId" params={{ periodId: String(periodId) }}>
            <Button variant="ghost" size="sm">
              View
            </Button>
          </Link>
        ) : (
          <Link to="/manage/period/$periodId" params={{ periodId: String(periodId) }} search={{ mode: 'edit' }}>
            <Button variant="ghost" size="sm">
              Edit
            </Button>
          </Link>
        )}
      </TableCell>
    </TableRow>
  )
}

export default function ManagePeriods() {
  const { data: periods = [], isLoading } = usePeriods()
  const { data: committees = [] } = useCommittees()

  // Index committees by id once, so each table row is an O(1) lookup rather than
  // a linear scan (O(periods × committees) across the whole table).
  const committeeById = useMemo(() => new Map(committees.map((c) => [c.idBase64Url, c])), [committees])

  function committeeRounds(committeeId: Uint8Array): string {
    const c = committeeById.get(toBase64Url(committeeId))
    return c ? `${c.periodStart} — ${c.periodEnd}` : '—'
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Manage periods</h1>
        <Link to="/manage/add-period">
          <Button>Add period</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : periods.length === 0 ? (
        <p className="text-muted-foreground">No periods created yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Committee (rounds)</TableHead>
              <TableHead>Voting window</TableHead>
              <TableHead>Ballot</TableHead>
              <TableHead>Ready</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.map(({ id, period, ready }) => (
              <PeriodTableRow
                key={id}
                periodId={id}
                period={period}
                ready={ready}
                committeeRounds={committeeRounds(period.committeeId)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
