import { useState } from 'react'
import type { CommitteePool } from '@/hooks/fracQueries'
import { useIsMobile } from '@/hooks/use-mobile'
import { Skeleton } from '@/components/ui/skeleton'
import { pctOf, segmentColor, TAIL_COLOR } from '@/lib/poolComposition'
import { cn } from '@/lib/utils'

/** Pools given their own bar segment and legend entry before the tail is grouped. */
const NAMED_DESKTOP = 6
const NAMED_MOBILE = 3

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

interface PoolCompositionBarProps {
  /** Pools holding power in the committee, strongest first. */
  pools: CommitteePool[]
  /** The committee's total votes — the denominator for every share. */
  totalVotes: number | undefined
  /** Pool set still resolving: bar and legend render as skeletons. */
  loading: boolean
  /** Shares still resolving (pools known, `totalVotes` not): bar only. */
  loadingShare?: boolean
  /**
   * What the untinted remainder of the track is. "Direct voters" only holds when
   * `pools` is every pool in the committee — a filtered set leaves other pools in
   * the remainder too.
   */
  remainderLabel?: string
  /** Bar height class, e.g. `h-2.5`. */
  barClassName?: string
  className?: string
}

/**
 * How a committee's voting power splits between staking pools and everyone else
 * — a stacked share bar plus its legend.
 *
 * Shared by the committee page's pooled card and the pools index, which show the
 * same split at different sizes. Collapsed, only the largest few pools get their
 * own segment and the tail is rolled into one band; expanding breaks every pool
 * out. Bar and legend always share that split, so a colour never appears without
 * a matching entry.
 */
export default function PoolCompositionBar({
  pools,
  totalVotes,
  loading,
  loadingShare = loading,
  remainderLabel = 'Direct voters',
  barClassName = 'h-2.5',
  className,
}: PoolCompositionBarProps) {
  const [legendOpen, setLegendOpen] = useState(false)
  const isMobile = useIsMobile()

  const pooledVotes = pools.reduce((sum, pool) => sum + pool.votes, 0)
  const pooledShare = loading ? undefined : pctOf(pooledVotes, totalVotes)
  const directShare = pooledShare === undefined ? undefined : 100 - pooledShare

  const namedCount = isMobile ? NAMED_MOBILE : NAMED_DESKTOP
  const named = legendOpen ? pools : pools.slice(0, namedCount)
  const tail = legendOpen ? [] : pools.slice(namedCount)
  const tailVotes = tail.reduce((sum, pool) => sum + pool.votes, 0)

  return (
    <div className={className}>
      {loadingShare ? (
        <Skeleton className={cn('w-full rounded-full', barClassName)} />
      ) : (
        <div className={cn('flex overflow-hidden rounded-full bg-muted', barClassName)}>
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
              style={{ width: `${pctOf(tailVotes, totalVotes) ?? 0}%`, background: TAIL_COLOR }}
            />
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {loading
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-3 w-28" />)
          : named.map((pool, i) => (
              <LegendEntry
                key={pool.instanceNumId}
                color={segmentColor(i)}
                label={pool.name}
                share={pctOf(pool.votes, totalVotes)}
              />
            ))}
        {!loading && tail.length > 0 && (
          <LegendEntry
            color={TAIL_COLOR}
            label={`Other pools (${tail.length.toLocaleString()})`}
            share={pctOf(tailVotes, totalVotes)}
          />
        )}
        {!loading && <LegendEntry label={remainderLabel} share={directShare} />}
        {!loading && pools.length > namedCount && (
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
  )
}
