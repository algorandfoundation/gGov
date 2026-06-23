import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { usePeriods, useCommittees, toBase64Url, type CommitteeOption } from '@/hooks/queries'
import { Skeleton } from '@/components/ui/skeleton'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Tag } from '@/components/ui/tag'
import { roundsToDays } from '@/utils/time'

const ROW_GRID = 'grid grid-cols-[1fr_88px_128px] items-center gap-4'

function CommitteeRow({ committee, usedBy }: { committee: CommitteeOption; usedBy: number[] }) {
  const rounds = committee.periodEnd - committee.periodStart
  const days = roundsToDays(rounds)
  return (
    <Link
      to="/committees/$committeeId" params={{ committeeId: committee.idBase64Url }}
      className={`${ROW_GRID} border-b border-border px-4.5 py-4 transition-colors hover:bg-muted/40`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-sm font-semibold text-primary dark:text-algo-teal">
            {committee.periodStart.toLocaleString()} – {committee.periodEnd.toLocaleString()}
          </span>
          {usedBy.map((id) => (
            <Tag key={id} tone="neutral">
              Used by Period {id}
            </Tag>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="tabular-nums">{rounds.toLocaleString()} rounds</span>
          {days > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">≈ {days.toLocaleString()} days</span>
            </>
          )}
        </div>
      </div>
      <span className="text-right text-sm font-semibold tabular-nums">{committee.totalMembers.toLocaleString()}</span>
      <span className="text-right text-sm font-semibold tabular-nums">{committee.totalVotes.toLocaleString()}</span>
    </Link>
  )
}

export default function Committees() {
  const { data: committees = [], isLoading } = useCommittees()
  const { data: periods = [] } = usePeriods()

  // Map each committee id → the period(s) that reference its window, for the
  // "Used by Period N" tag. Periods carry the committee id, not vice-versa.
  const usedByCommittee = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const p of periods) {
      const id = toBase64Url(p.period.committeeId)
      const list = map.get(id) ?? []
      list.push(p.id)
      map.set(id, list)
    }
    for (const list of map.values()) list.sort((a, b) => a - b)
    return map
  }, [periods])

  return (
    <div className="mx-auto max-w-[880px]">
      <Eyebrow>Algorand governance</Eyebrow>
      <h1 className="mt-2 font-display text-[40px] font-bold leading-none">Committees</h1>
      <p className="mt-3 max-w-[64ch] text-base leading-[1.45] text-muted-foreground">
        Voting power is determined by block production. Each committee tracks the blocks produced over a range of
        rounds — one block, one vote. Select a committee to see its members and their individual vote weights.
      </p>

      {isLoading ? (
        <div className="mt-7 flex flex-col gap-2.5">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : committees.length === 0 ? (
        <p className="mt-7 text-muted-foreground">No committees found.</p>
      ) : (
        <div className="mt-7">
          {/* Column header */}
          <div
            className={`${ROW_GRID} border-b border-input px-4.5 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground`}
          >
            <span>Rounds</span>
            <span className="text-right">Members</span>
            <span className="text-right">Total votes</span>
          </div>
          <div className="flex flex-col">
            {committees.map((c) => (
              <CommitteeRow key={c.idBase64Url} committee={c} usedBy={usedByCommittee.get(c.idBase64Url) ?? []} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
