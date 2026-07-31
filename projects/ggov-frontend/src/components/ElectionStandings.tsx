import { cn } from '@/lib/utils'

export interface StandingCandidate {
  /** Candidate handle — the topic-body title. */
  name: string
  support: number
  veto: number
  abstain: number
}

interface ElectionStandingsProps {
  candidates: StandingCandidate[]
  /** Seats the race fills; the top `seats` by net score are in range. */
  seats: number
  /**
   * The race's own on-chain labels for the three sentiments. Options are free-form,
   * so a period seeded before the Veto rename reads "Against" here and should say so.
   */
  labels: { yes: string; no: string; abstain: string }
}

/**
 * The read-only standing of one election's candidates, ranked by net score
 * (Support − Veto). Used on the period detail page wherever the voter isn't
 * scoring — logged out, not eligible, or after voting closed.
 *
 * Deliberately provisional: candidates in the top `seats` are marked "in seat
 * range", never seated. The full ranked view with the cutoff divider lives on the
 * results page ({@link ElectionResults}); this is its in-ballot summary.
 */
export default function ElectionStandings({ candidates, seats, labels }: ElectionStandingsProps) {
  const ranked = candidates.map((c) => ({ ...c, net: c.support - c.veto })).sort((a, b) => b.net - a.net)
  // Bars are scaled against the widest score in the race, so a race decided by a
  // narrow margin still reads. Guard the all-zero case (no votes cast yet).
  const maxAbs = Math.max(1, ...ranked.map((c) => Math.abs(c.net)))

  return (
    <div className="flex flex-col gap-3.5 px-[18px] py-4">
      {ranked.map((c, i) => {
        const inRange = i < seats
        const negative = c.net < 0
        return (
          <div key={`${c.name}-${i}`}>
            <div className="mb-[7px] flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-[9px]">
                <span
                  className={cn(
                    'w-4 shrink-0 font-display text-[12.5px] font-bold tabular-nums',
                    inRange ? 'text-primary dark:text-algo-teal' : 'text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                <span
                  className={cn(
                    'truncate text-[14px]',
                    inRange ? 'font-bold text-foreground' : 'font-medium text-muted-foreground',
                  )}
                >
                  {c.name}
                </span>
                {inRange && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-[7px] py-[2px] text-[10.5px] font-semibold text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
                    in seat range
                  </span>
                )}
              </div>
              <span className="shrink-0 text-[13px] text-muted-foreground">
                net{' '}
                <strong className="text-foreground tabular-nums">
                  {(negative ? '−' : '+') + Math.abs(c.net).toLocaleString()}
                </strong>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted/50">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  negative ? 'bg-algo-orange' : inRange ? 'bg-primary' : 'bg-algo-navy-40',
                )}
                style={{ width: `${Math.max(2, Math.round((Math.abs(c.net) / maxAbs) * 100))}%` }}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-3 text-[11.5px] tabular-nums text-muted-foreground">
              <span className="text-success-strong">
                {labels.yes} {c.support.toLocaleString()}
              </span>
              <span className="text-destructive-strong">
                {labels.no} {c.veto.toLocaleString()}
              </span>
              <span>
                {labels.abstain} {c.abstain.toLocaleString()}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
