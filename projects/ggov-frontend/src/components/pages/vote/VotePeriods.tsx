import { usePeriods } from '@/hooks/queries'
import { Skeleton } from '@/components/ui/skeleton'
import PeriodCard from '@/components/PeriodCard'
import { periodStatus } from '@/utils/time'

export default function VotePeriods() {
  const { data: periods = [], isLoading } = usePeriods()

  // Voters only see periods the operator has marked ready, latest first.
  const readyPeriods = periods.filter((p) => p.ready).sort((a, b) => b.id - a.id)
  // Bucket in a single pass — periodStatus() reads the clock, so compute it once per period.
  const active: typeof readyPeriods = []
  const upcoming: typeof readyPeriods = []
  const past: typeof readyPeriods = []
  for (const p of readyPeriods) {
    const status = periodStatus(p.period.votingStart, p.period.votingEnd)
    if (status === 'active') active.push(p)
    else if (status === 'upcoming') upcoming.push(p)
    else past.push(p)
  }

  const sections = [
    { label: 'Active', items: active },
    { label: 'Upcoming', items: upcoming },
    { label: 'Past', items: past },
  ].filter((s) => s.items.length > 0)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Governance periods</h1>
        <div className="grid gap-4 grid-cols-1">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Governance periods</h1>
      {sections.length === 0 ? (
        <p className="text-muted-foreground">No governance periods found.</p>
      ) : (
        sections.map(({ label, items }) => (
          <section key={label} className="space-y-3">
            <h2 className="text-lg font-semibold">{label}</h2>
            <div className="grid gap-4 grid-cols-1">
              {items.map((p) => (
                <PeriodCard key={p.id} periodId={p.id} period={p.period} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
