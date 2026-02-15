import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useCommittees, useCommitteeMembers } from '@/hooks/queries'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { ellipseAddress } from '@/utils/ellipseAddress'

const PAGE_SIZE = 25

export default function CommitteeDetail() {
  const { committeeId } = useParams<{ committeeId: string }>()
  const { data: committees = [] } = useCommittees()
  const { data: members = [], isLoading } = useCommitteeMembers(committeeId)
  const [page, setPage] = useState(0)

  const committee = committees.find((c) => c.idBase64Url === committeeId)

  const totalPages = Math.ceil(members.length / PAGE_SIZE)
  const paginated = members.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/committees" className="text-sm text-muted-foreground hover:text-foreground">&larr; Back</Link>
      </div>

      <h1 className="text-2xl font-bold">Committee</h1>

      {committee && (
        <div className="text-sm text-muted-foreground space-y-1">
          <div>Rounds: {committee.periodStart} — {committee.periodEnd}</div>
          <div>{committee.totalMembers} members &middot; {committee.totalVotes} total votes</div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : members.length === 0 ? (
        <p className="text-muted-foreground">No members found.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Votes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((m, i) => {
                const addr = String(m.account)
                return (
                  <TableRow key={addr}>
                    <TableCell className="text-muted-foreground tabular-nums">{page * PAGE_SIZE + i + 1}</TableCell>
                    <TableCell>
                      <Link
                        to={`/account/${addr}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {ellipseAddress(addr, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.votes}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
