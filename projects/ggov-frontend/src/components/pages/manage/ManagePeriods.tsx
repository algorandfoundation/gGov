import { Link } from 'react-router-dom'
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

  function committeeRounds(committeeId: Uint8Array): string {
    const key = toBase64Url(committeeId)
    const c = committees.find((c) => c.idBase64Url === key)
    return c ? `${c.periodStart} — ${c.periodEnd}` : '—'
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Manage Periods</h1>
        <Link to="/manage/add-period">
          <Button>Add Period</Button>
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
              <TableHead>Committee (Rounds)</TableHead>
              <TableHead>Voting Window</TableHead>
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
                        ? 'bg-green-500/20 text-green-700 dark:text-green-300'
                        : 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300')
                    }
                  >
                    {ready ? 'Ready' : 'Draft'}
                  </span>
                </TableCell>
                <TableCell>
                  <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
                </TableCell>
                <TableCell>
                  <Link to={`/manage/period/${id}`}>
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
