import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Download } from 'lucide-react'
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

  const exportCsv = () => {
    if (!committee) return
    const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`
    const rows = [
      ['Account', 'Votes'],
      ...members.map((m) => [String(m.account), String(m.votes)]),
    ]
    const csv = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')
    const safeId = committee.idBase64Url.replace(/[^a-zA-Z0-9-_]/g, '_')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${committee.periodStart}-${committee.periodEnd}-${safeId}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/committees" className="text-sm text-muted-foreground hover:text-foreground">&larr; Back</Link>
      </div>

      <h1 className="text-2xl font-bold">Committee</h1>

      {committee && (
        <div className="flex items-end justify-between gap-3">
          <div className="text-sm text-muted-foreground space-y-1">
            <div>Rounds: {committee.periodStart} — {committee.periodEnd}</div>
            <div>{committee.totalMembers} members &middot; {committee.totalVotes} total votes</div>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={members.length === 0}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
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
