import { Eyebrow } from '@/components/ui/eyebrow'
import { formatCompact } from '@/utils/format'
import { cn } from '@/lib/utils'

interface TurnoutCardProps {
  /**
   * Voting power that voted: the max per-topic tally sum, not a sum across topics —
   * each topic re-counts the same power, so summing would multiply turnout by the
   * topic count. The denominator below is the eligible committee power.
   */
  votesCast: number
  totalPower: number
  /** Distinct governors that voted and the eligible governor count. */
  governorsVoted: number
  totalGovernors: number
  className?: string
}

function pctOf(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0
  return Math.min(100, Math.max(0, (part / whole) * 100))
}

function TurnoutBar({
  label,
  pct,
  caption,
  barClass,
  valueClass,
}: {
  label: string
  pct: number
  caption: string
  barClass: string
  valueClass: string
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2.5">
        <span className="text-[13px] font-semibold text-foreground">{label}</span>
        <span className={cn('font-display text-base font-bold tabular-nums', valueClass)}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-[9px] overflow-hidden rounded-full bg-muted/50">
        <div className={cn('h-full rounded-full', barClass)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 text-[11.5px] text-muted-foreground">{caption}</div>
    </div>
  )
}

/**
 * Two-bar turnout meter for the Period Results sidebar. Deliberately exposes the
 * gap between power-weighted and head-count turnout: "Voting power" (blue) = votes
 * cast ÷ eligible committee power; "Governors" (teal) = governors who voted ÷
 * eligible governors. Informational only — this governance model has no quorum.
 */
export default function TurnoutCard({
  votesCast,
  totalPower,
  governorsVoted,
  totalGovernors,
  className,
}: TurnoutCardProps) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      <Eyebrow>Turnout</Eyebrow>
      <div className="mt-3.5 flex flex-col gap-3.5">
        <TurnoutBar
          label="Voting power"
          pct={pctOf(votesCast, totalPower)}
          caption={`${formatCompact(votesCast)} of ${formatCompact(totalPower)} votes cast`}
          barClass="bg-algo-blue"
          valueClass="text-algo-blue"
        />
        <TurnoutBar
          label="Governors"
          pct={pctOf(governorsVoted, totalGovernors)}
          caption={`${governorsVoted.toLocaleString()} of ${totalGovernors.toLocaleString()} governors voted`}
          barClass="bg-algo-teal"
          valueClass="text-algo-teal"
        />
      </div>
    </div>
  )
}
