import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useCommitteePools } from '@/hooks/fracQueries'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import PoolCompositionBar from '@/components/PoolCompositionBar'
import { pctOf } from '@/lib/poolComposition'
import { cn } from '@/lib/utils'

/**
 * One figure in the stat row. `loading` is per-tile rather than per-card: the
 * pool figures come from the frac registry while the share also needs the
 * committee's total votes, so the two resolve — and fill in — independently.
 */
function StatTile({
  label,
  value,
  loading,
  valueClassName,
}: {
  label: string
  value: string
  loading: boolean
  valueClassName?: string
}) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-20" />
      ) : (
        <div className={cn('mt-2 font-display text-2xl font-bold leading-none tabular-nums', valueClassName)}>
          {value}
        </div>
      )}
    </div>
  )
}

interface PooledVotingCardProps {
  /** base64url committee id; the section fetches its own pool data from it. */
  committeeId: string | undefined
  /** The committee's total votes — the denominator for every share. */
  totalVotes: number | undefined
  /** Whether the committee metadata (and so `totalVotes`) is still resolving. */
  loadingTotalVotes: boolean
  className?: string
}

/**
 * How much of a committee's voting power sits in staking pools, and in which.
 *
 * Part of the committee detail summary, but every figure loads on its own: the
 * pool set comes from the frac registry, and the shares additionally need the
 * committee's total votes — so no single slow read blanks the whole card.
 *
 * The figures here are a pool's *own* power, which is exact, so they carry no
 * "≈" — unlike a member's split of it (see the `hooks/fracQueries.ts` docblock).
 */
export default function PooledVotingCard({
  committeeId,
  totalVotes,
  loadingTotalVotes,
  className,
}: PooledVotingCardProps) {
  const { pools, pooledVotes, participants, isLoading, isError, fracEnabled } = useCommitteePools(committeeId)

  const pooledShare = isLoading ? undefined : pctOf(pooledVotes, totalVotes)
  const loadingPools = isLoading
  const loadingShare = isLoading || loadingTotalVotes

  // A network with no frac registry has no pooled voting at all — issue no query
  // and show no section, the same gate every other pooled surface uses.
  if (!fracEnabled) return null

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-card shadow-sm', className)}>
      <div className="flex flex-col gap-4 px-5 pt-5 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <Eyebrow className="text-algo-blue dark:text-algo-teal">Pooled voting</Eyebrow>
          <p className="mt-2 max-w-[58ch] text-[13px] leading-[1.5] text-muted-foreground">
            Part of this committee's voting power sits in liquid staking tokens and staking pools. Members of those
            pools vote with a prorated share.
          </p>
        </div>
        {committeeId && (
          <Link
            to="/pools/$committeeId"
            params={{ committeeId }}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3.5 py-2 font-display text-sm font-bold text-algo-blue transition-colors hover:border-ring sm:min-h-0 dark:text-algo-teal"
          >
            View pools
            <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>

      {isError ? (
        <p className="mt-4 border-t border-border px-5 py-4 text-[13px] text-muted-foreground">
          Pooled voting data is unavailable right now.
        </p>
      ) : !loadingPools && pools.length === 0 ? (
        <p className="mt-4 border-t border-border px-5 py-4 text-[13px] text-muted-foreground">
          No pool has synced this committee, so none of its voting power is pooled.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
            <StatTile
              label="Pooled share"
              value={pooledShare === undefined ? '—' : `${pooledShare.toFixed(1)}%`}
              loading={loadingShare}
              valueClassName="text-algo-blue dark:text-algo-teal"
            />
            <StatTile label="Pooled votes" value={pooledVotes.toLocaleString()} loading={loadingPools} />
            <StatTile label="Pools" value={pools.length.toLocaleString()} loading={loadingPools} />
            <StatTile label="Pool participants" value={participants.toLocaleString()} loading={loadingPools} />
          </div>

          {/* Composition bar: a segment per named pool, then the pooled tail;
              whatever is left of the track is the direct voters' share. */}
          <PoolCompositionBar
            className="border-t border-border px-5 pb-4 pt-3.5"
            pools={pools}
            totalVotes={totalVotes}
            loading={loadingPools}
            loadingShare={loadingShare}
          />
        </>
      )}
    </div>
  )
}
