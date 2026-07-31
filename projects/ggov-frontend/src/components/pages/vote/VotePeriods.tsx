import { useMemo, useState } from 'react'
import { usePeriods, toBase64Url, type PeriodWithId } from '@/hooks/queries'
import { periodStatus, type PeriodStatus } from '@/utils/time'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Eyebrow } from '@/components/ui/eyebrow'
import SidebarLayout from '@/components/SidebarLayout'
import ActivePeriodHero from '@/components/vote/ActivePeriodHero'
import PeriodRow, { PERIOD_ROW_GRID } from '@/components/vote/PeriodRow'
import {
  AccountCard,
  VotingPowerCard,
  HowGovernanceWorksCard,
  PeriodStatsCard,
  LegacyPortalCard,
} from '@/components/vote/VoteSidebar'

type StatusFilter = 'all' | 'active' | 'upcoming' | 'closed'

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'closed', label: 'Closed' },
]

/** Map a period's computed status onto a filter bucket ("ended" → "closed"). */
function filterBucket(status: PeriodStatus): Exclude<StatusFilter, 'all'> {
  return status === 'ended' ? 'closed' : status
}

export default function VotePeriods() {
  const { data: periods = [], isLoading } = usePeriods()
  const [filter, setFilter] = useState<StatusFilter>('all')

  // Voters only see periods the operator has marked ready, latest first.
  const readyPeriods = useMemo(() => periods.filter((p) => p.ready).sort((a, b) => b.id - a.id), [periods])

  // The single active period drives the hero; latest one wins if several overlap.
  const activePeriod = useMemo(
    () => readyPeriods.find((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'active'),
    [readyPeriods],
  )

  const filtered = useMemo(
    () =>
      readyPeriods.filter((p) =>
        filter === 'all' ? true : filterBucket(periodStatus(p.period.votingStart, p.period.votingEnd)) === filter,
      ),
    [readyPeriods, filter],
  )

  // Committee that frames the voting-power / window / eligible-voter sidebar stats:
  // the active period's, else the most recent ready period's.
  const contextPeriod: PeriodWithId | undefined = activePeriod ?? readyPeriods[0]
  const contextCommitteeId = contextPeriod ? toBase64Url(contextPeriod.period.committeeId) : undefined

  const sidebar = (
    <div className="flex flex-col gap-4">
      <AccountCard />
      <VotingPowerCard committeeId={contextCommitteeId} />
      <HowGovernanceWorksCard />
      <PeriodStatsCard committeeId={contextCommitteeId} />
      <LegacyPortalCard />
    </div>
  )

  return (
    <SidebarLayout sidebar={sidebar} sidebarClassName="lg:w-[348px]">
      <div className="min-w-0">
        {/* Header */}
        <Eyebrow>Algorand governance</Eyebrow>
        <h1 className="mt-2 text-[40px] leading-none">Voting periods</h1>
        <p className="mt-3 max-w-[62ch] text-base leading-[1.45] text-muted-foreground">
          Review the questions in front of the community and cast your vote. Your weight is the number of blocks you
          produced in the current window — no commitment or opt-in required.
        </p>

        {isLoading ? (
          <div className="mt-6 flex flex-col gap-3">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : readyPeriods.length === 0 ? (
          <p className="mt-6 text-muted-foreground">No voting periods found.</p>
        ) : (
          <>
            {activePeriod && <ActivePeriodHero periodId={activePeriod.id} period={activePeriod.period} />}

            {/* All periods */}
            <div className="mt-8 mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-[21px]">All periods</h3>
              <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
                <TabsList>
                  {FILTERS.map((f) => (
                    <TabsTrigger key={f.value} value={f.value}>
                      {f.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {/* Column header (desktop) */}
            <div
              className={cn(
                'hidden gap-3.5 px-4 pb-2 text-[11.5px] uppercase tracking-[0.04em] text-muted-foreground md:grid',
                PERIOD_ROW_GRID,
              )}
            >
              <span>ID</span>
              <span>Period</span>
              <span>Dates</span>
              {/* Not "Topics": an election period's rows count candidates, or
                  its elections when it runs more than one. */}
              <span>Ballot</span>
              <span className="text-right">Status</span>
            </div>

            <div className="flex flex-col gap-2">
              {filtered.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">No periods match this filter.</p>
              ) : (
                filtered.map((p) => <PeriodRow key={p.id} periodId={p.id} period={p.period} />)
              )}
            </div>
          </>
        )}
      </div>
    </SidebarLayout>
  )
}
