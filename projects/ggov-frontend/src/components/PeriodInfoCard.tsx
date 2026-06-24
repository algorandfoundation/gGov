import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Eyebrow } from '@/components/ui/eyebrow'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { formatTimestamp } from '@/utils/time'
import { cn } from '@/lib/utils'

interface PeriodInfoCardProps {
  /** Voting window start, unix seconds. */
  votingStart: number
  /** Voting window end, unix seconds. */
  votingEnd: number
  /** Number of topics in the period. */
  topics: number
  /** Total voting power exercised so far across the period. */
  votesCast: number
  /** Committee size — number of governors eligible to vote. Undefined while loading. */
  eligibleGovernors?: number
  /** Link to the period's committee; makes the Eligible Governors row a link. */
  committeeHref?: string
  className?: string
}

/** A label/value row in a sidebar info card. The label becomes a link when `href` is set. */
export function InfoRow({ label, href, children }: { label: string; href?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      {href ? (
        <Link to={href} className="text-[13px] text-primary hover:underline dark:text-algo-teal">
          {label}
        </Link>
      ) : (
        <span className="text-[13px] text-muted-foreground">{label}</span>
      )}
      {children}
    </div>
  )
}

/** Period-level metadata and stats shown in the voting sidebar. */
export default function PeriodInfoCard({
  votingStart,
  votingEnd,
  topics,
  votesCast,
  eligibleGovernors,
  committeeHref,
  className,
}: PeriodInfoCardProps) {
  return (
    <div className={cn('flex flex-col gap-4 rounded-xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Period information</Eyebrow>
        <PeriodStatusBadge votingStart={votingStart} votingEnd={votingEnd} />
      </div>
      <div className="flex flex-col gap-3">
        <InfoRow label="Starts">
          <span className="text-sm font-medium tabular-nums">{formatTimestamp(votingStart)}</span>
        </InfoRow>
        <InfoRow label="Ends">
          <span className="text-sm font-medium tabular-nums">{formatTimestamp(votingEnd)}</span>
        </InfoRow>
        <InfoRow label="Topics">
          <span className="font-display text-[19px] font-bold tabular-nums">{topics.toLocaleString()}</span>
        </InfoRow>
        <InfoRow label="Eligible governors" href={committeeHref}>
          <span className="font-display text-[19px] font-bold tabular-nums">
            {eligibleGovernors?.toLocaleString() ?? '—'}
          </span>
        </InfoRow>
        <InfoRow label="Votes cast">
          <span className="font-display text-[19px] font-bold tabular-nums">{votesCast.toLocaleString()}</span>
        </InfoRow>
      </div>
    </div>
  )
}
