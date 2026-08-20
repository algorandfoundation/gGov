import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useCommitteePools } from '@/hooks/fracQueries'
import { useIsMobile } from '@/hooks/use-mobile'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// TODO(routing): the pooled-voting pages ("Pooled Voting Pools" / "Pooled Voting
// Detail" in the design) don't exist yet, so this is a stub href. Once the route
// lands, swap it for a typed <Link to="/pools/$committeeId" params={{ committeeId }} />
// — the design deep-links pool composition per committee rather than holding the
// selected committee in component state.
const POOLS_HREF = '#'

/** Composition-bar palette; theme-aware and cycled when a committee has more pools. */
const SEGMENT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

const segmentColor = (index: number) => SEGMENT_COLORS[index % SEGMENT_COLORS.length]

/** Pools given their own bar segment and legend entry before the tail is grouped. */
const NAMED_DESKTOP = 6
const NAMED_MOBILE = 3

function pctOf(part: number, whole: number | undefined): number | undefined {
  if (whole === undefined) return undefined
  if (whole <= 0) return 0
  return (part / whole) * 100
}

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

/**
 * One legend entry: a swatch matching its bar segment, a label, and its share.
 * A missing `color` is the untinted track — the direct-voters remainder.
 */
function LegendEntry({ color, label, share }: { color?: string; label: string; share: number | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-[15px] text-muted-foreground">
      <span
        className={cn('size-2 shrink-0 rounded-[2px]', color ? undefined : 'border border-input bg-muted')}
        style={color ? { background: color } : undefined}
      />
      <span>{label}</span>
      {share !== undefined && <span className="tabular-nums">· {share.toFixed(1)}%</span>}
    </span>
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
  const [legendOpen, setLegendOpen] = useState(false)
  const isMobile = useIsMobile()

  const pooledShare = isLoading ? undefined : pctOf(pooledVotes, totalVotes)
  const directShare = pooledShare === undefined ? undefined : 100 - pooledShare
  const loadingPools = isLoading
  const loadingShare = isLoading || loadingTotalVotes

  // Collapsed, only the largest few pools get their own segment and the tail is
  // rolled into one band; expanding breaks every pool out. Bar and legend share
  // the split so a colour always has a matching entry.
  const namedCount = isMobile ? NAMED_MOBILE : NAMED_DESKTOP
  const named = legendOpen ? pools : pools.slice(0, namedCount)
  const tail = legendOpen ? [] : pools.slice(namedCount)
  const tailVotes = tail.reduce((sum, pool) => sum + pool.votes, 0)

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
        <a
          href={POOLS_HREF}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3.5 py-2 font-display text-sm font-bold text-algo-blue transition-colors hover:border-ring sm:min-h-0 dark:text-algo-teal"
        >
          View pools
          <ArrowRight className="size-3.5" />
        </a>
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

          <div className="border-t border-border px-5 pb-4 pt-3.5">
            {/* Composition bar: a segment per named pool, then the pooled tail;
                whatever is left of the track is the direct voters' share. */}
            {loadingShare ? (
              <Skeleton className="h-2.5 w-full rounded-full" />
            ) : (
              <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                {named.map((pool, i) => {
                  const share = pctOf(pool.votes, totalVotes) ?? 0
                  return (
                    <div
                      key={pool.instanceNumId}
                      title={`${pool.name} · ${share.toFixed(1)}%`}
                      style={{ width: `${share}%`, background: segmentColor(i) }}
                    />
                  )
                })}
                {tail.length > 0 && (
                  <div
                    title={`${tail.length} smaller pools`}
                    style={{ width: `${pctOf(tailVotes, totalVotes) ?? 0}%`, background: 'var(--algo-navy-40)' }}
                  />
                )}
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
              {loadingPools
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-3 w-28" />)
                : named.map((pool, i) => (
                    <LegendEntry
                      key={pool.instanceNumId}
                      color={segmentColor(i)}
                      label={pool.name}
                      share={pctOf(pool.votes, totalVotes)}
                    />
                  ))}
              {!loadingPools && tail.length > 0 && (
                <LegendEntry
                  color="var(--algo-navy-40)"
                  label={`Other pools (${tail.length.toLocaleString()})`}
                  share={pctOf(tailVotes, totalVotes)}
                />
              )}
              {!loadingPools && <LegendEntry label="Direct voters" share={directShare} />}
              {!loadingPools && pools.length > namedCount && (
                <button
                  type="button"
                  onClick={() => setLegendOpen((open) => !open)}
                  className="text-[11.5px] font-semibold leading-[15px] text-algo-blue hover:underline dark:text-algo-teal"
                >
                  {legendOpen ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
