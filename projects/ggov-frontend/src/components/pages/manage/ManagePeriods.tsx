import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { usePeriods, useCommittees } from '@/hooks/queries'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { formatTimestampUTC } from '@/utils/time'
import { toBase64Url } from '@/hooks/queries'

export default function ManagePeriods() {
  const { data: periods = [], isLoading } = usePeriods()
  const { data: committees = [] } = useCommittees()

  // Index committees by id once, so each table row is an O(1) lookup rather than
  // a linear scan (O(periods × committees) across the whole table).
  const committeeById = useMemo(
    () => new Map(committees.map((c) => [c.idBase64Url, c])),
    [committees],
  )

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
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : periods.length === 0 ? (
        <p className="text-muted-foreground">No periods created yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Committee (rounds)</TableHead>
              <TableHead>Voting window</TableHead>
              <TableHead>Topics</TableHead>
              <TableHead>Ready</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.map(({ id, period, ready }) => (
              <TableRow key={id}>
                <TableCell className="font-medium">{id}</TableCell>
                <TableCell className="text-sm">{committeeRounds(period.committeeId)}</TableCell>
                <TableCell className="text-sm">
                  {formatTimestampUTC(period.votingStart)} — {formatTimestampUTC(period.votingEnd)}
                </TableCell>
                <TableCell>{period.topics.length}</TableCell>
                <TableCell>
                  <span
                    className={
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                      (ready
                        ? 'bg-success/15 text-success-strong'
                        : 'bg-warning/15 text-warning-strong')
                    }
                  >
                    {ready ? 'Ready' : 'Draft'}
                  </span>
                </TableCell>
                <TableCell>
                  <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
                </TableCell>
                <TableCell>
                  <Link to="/manage/period/$periodId" params={{ periodId: String(id) }}>
                    <Button variant="ghost" size="sm">Edit</Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
