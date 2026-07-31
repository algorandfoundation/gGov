import * as React from 'react'
import { classifyOption } from '@/utils/vote'
import { plural } from '@/utils/periodTerms'
import { cn } from '@/lib/utils'

/** Score a sentiment contributes to a candidate's net, for the ballot legend. */
const WEIGHT = { yes: '+1', no: '−1', abstain: '0' } as const

interface ElectionCardProps {
  /** 0-based index in the period body's `elect`, rendered as the mono `E.0N` chip. */
  electionIndex: number
  /** The race's name (`Election.t`). */
  title: string
  /** Seats the race fills (`Election.s`). */
  seats: number
  candidateCount: number
  /**
   * Ballot state. Present only while the voter is actually scoring: it draws the
   * legend band above the candidates and the progress footer below them. The
   * read-only views pass `note` instead — they have no choices to track.
   *
   * `options` are the on-chain labels of any one candidate in the race (they are
   * fixed across a race), classified into the +1/−1/0 key.
   */
  scoring?: { scored: number; options: string[] }
  /** Read-only footer line — the standings' seat-cutoff note. */
  note?: React.ReactNode
  children: React.ReactNode
}

/**
 * One election on a period's ballot: a titled card banding together the candidates
 * standing in that race, with the seat count it fills.
 *
 * A period can run several races on one ballot, and a candidate is only ever ranked
 * against the others in its own race — so the grouping is what makes the ballot
 * readable. Presentation only: the cards inside stay keyed by on-chain topic index.
 */
export default function ElectionCard({
  electionIndex,
  title,
  seats,
  candidateCount,
  scoring,
  note,
  children,
}: ElectionCardProps) {
  const code = `E.${String(electionIndex + 1).padStart(2, '0')}`
  const complete = scoring != null && scoring.scored === candidateCount

  // Only the recognized sentiments carry a score; a free-form label the classifier
  // doesn't know has no weight to advertise, so it stays out of the key.
  const legend = scoring
    ? scoring.options
        .map((label) => ({ label, sentiment: classifyOption(label) }))
        .filter((o): o is { label: string; sentiment: keyof typeof WEIGHT } => o.sentiment !== 'other')
    : []

  return (
    <section className="overflow-hidden rounded-xl border border-t-[3px] border-border border-t-primary bg-card shadow-sm">
      <div className="flex flex-col gap-1.5 border-b border-border px-[18px] py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-[9px]">
          <span className="shrink-0 rounded-[5px] bg-primary/10 px-[7px] py-[3px] font-mono text-[11px] font-semibold tracking-[0.04em] text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
            {code}
          </span>
          <h3 className="min-w-0 font-display text-lg font-bold">{title}</h3>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-[2px] text-[11px] font-semibold text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
            election
          </span>
        </div>
        {/* Narrow screens have no room for a right-hand column beside a wrapping
            title, so the same two figures run as one muted line underneath. */}
        <div className="text-[11.5px] tabular-nums text-muted-foreground sm:hidden">
          {plural(seats, 'seat')} open · {plural(candidateCount, 'candidate')}
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="font-display text-[15px] font-bold tabular-nums">{plural(seats, 'seat')} open</div>
          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{plural(candidateCount, 'candidate')}</div>
        </div>
      </div>

      {scoring && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border bg-muted/50 px-[18px] py-[9px]">
          <span className="text-[11.5px] text-muted-foreground">
            Score every candidate — top {seats} by net score are elected
          </span>
          <div className="flex items-center gap-3 text-[11px] font-semibold">
            {legend.map((o) => (
              <span
                key={o.label}
                className={cn(
                  o.sentiment === 'yes' && 'text-success-strong',
                  o.sentiment === 'no' && 'text-destructive-strong',
                  o.sentiment === 'abstain' && 'text-muted-foreground',
                )}
              >
                {o.label} {WEIGHT[o.sentiment]}
              </span>
            ))}
          </div>
        </div>
      )}

      {children}

      {scoring && (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/50 px-[18px] py-[11px]">
          <span className="text-[12.5px] tabular-nums text-muted-foreground">
            {scoring.scored} of {plural(candidateCount, 'candidate')} scored
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold',
              complete ? 'text-success-strong' : 'text-[#7A5A00] dark:text-warning',
            )}
          >
            <span className={cn('size-[7px] rounded-full', complete ? 'bg-success' : 'bg-warning-strong')} />
            {complete ? 'Complete' : 'Incomplete'}
          </span>
        </div>
      )}

      {note && (
        <div className="border-t border-border bg-muted/50 px-[18px] py-[11px] text-[11.5px] text-muted-foreground">
          {note}
        </div>
      )}
    </section>
  )
}
