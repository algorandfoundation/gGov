import { usePeriods } from '@/hooks/queries'
import { Skeleton } from '@/components/ui/skeleton'
import PeriodCard from '@/components/PeriodCard'
import { periodStatus } from '@/utils/time'

export default function VotePeriods() {
  const { data: periods = [], isLoading } = usePeriods()

  // Voters only see periods the operator has marked ready.
  const readyPeriods = periods.filter((p) => p.ready)
  const active = readyPeriods.filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'active')
  const upcoming = readyPeriods.filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'upcoming')
  const past = readyPeriods.filter((p) => periodStatus(p.period.votingStart, p.period.votingEnd) === 'ended')

  const sections = [
    { label: 'Active', items: active },
    { label: 'Upcoming', items: upcoming },
    { label: 'Past', items: past },
  ].filter((s) => s.items.length > 0)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Governance Periods</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Governance Periods</h1>
      {sections.length === 0 ? (
        <p className="text-muted-foreground">No governance periods found.</p>
      ) : (
        sections.map(({ label, items }) => (
          <section key={label} className="space-y-3">
            <h2 className="text-lg font-semibold">{label}</h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
