import { Eyebrow } from '@/components/ui/eyebrow'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { formatApprox } from '@/utils/format'
import { cn } from '@/lib/utils'
import type { PooledBallotPosition } from '@/hooks/fracQueries'

/**
 * The teal sibling of {@link CollectiveStatusCard}: what the connected wallet holds
 * in staking pools for this period's committee, as opposed to the block-production
 * power it holds directly.
 *
 * The headline counts the **active account's** positions only. Every other row —
 * another of the wallet's accounts, or an account that delegated to you — is listed
 * and labelled "· via <account>", but excluded from the total: that power is yours
 * to *cast*, not yours to hold. (This follows the design, whose headline is likewise
 * the sum of its own rows; the design's mock just had a single connected account.)
 *
 * Labelling by the active account rather than by wallet membership matters as soon
 * as a wallet holds several accounts in the same pools — otherwise this flat list
 * shows two identically-named rows at different percentages with nothing to tell
 * them apart. The nested selector doesn't need it: there, the owner is the row a
 * position hangs under.
 *
 * When the active account holds no pools and only carries someone else's, that rule
 * would put a bare "≈ 0.00" above a non-empty list. The card then switches to
 * totalling what you can cast, and says so — rather than reporting zero next to
 * real weight.
 *
 * Every figure is approximate and shown behind "≈": on-chain the pool splits its
 * power as `floor(tally x totalVotes / totalAq)` with the last option absorbing the
 * remainder, so a member's realised weight depends on how the rest of the pool
 * votes. See the `hooks/fracQueries.ts` docblock.
 */
/** One pool's line: name (+ whose it is, when not the active account's) against share and weight. */
function PoolRow({ position, mine }: { position: PooledBallotPosition; mine: boolean }) {
  const { data: name } = useAddressName(mine ? '' : position.owner)
  return (
    <div className="flex items-baseline justify-between gap-3.5">
      <span className="text-[13px] text-muted-foreground">
        {position.instanceName}
        {mine ? '' : ` · via ${name ?? ellipseAddress(position.owner, 4)}`}
      </span>
      <span className="shrink-0 text-[13px] font-semibold tabular-nums">
        {position.sharePct.toFixed(2)}% · ≈ {formatApprox(position.votes)}
      </span>
    </div>
  )
}

export default function PooledSharePanel({
  positions,
  activeAddress,
  className,
}: {
  positions: PooledBallotPosition[]
  /** The connected account; its positions are the ones the headline totals. */
  activeAddress: string
  className?: string
}) {
  if (positions.length === 0) return null

  const isMine = (p: PooledBallotPosition) => p.owner === activeAddress
  const mine = positions.filter(isMine)
  const othersOnly = mine.length === 0
  const total = (othersOnly ? positions : mine).reduce((sum, p) => sum + p.votes, 0)
  const rows = [...positions].sort((a, b) => b.votes - a.votes)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border border-t-[3px] border-t-algo-teal bg-card shadow-sm',
        className,
      )}
    >
      <div className="px-5 pb-4 pt-[18px]">
        <Eyebrow>{othersOnly ? 'Pooled share you can cast' : 'Your pooled share'}</Eyebrow>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-display text-[34px] font-bold leading-none tabular-nums text-teal-strong">
            ≈ {formatApprox(total)}
          </span>
          <span className="text-[13px] text-muted-foreground">votes</span>
        </div>
        <div className="mt-3.5 flex flex-col gap-[9px]">
          {rows.map((position) => (
            <PoolRow key={position.id} position={position} mine={isMine(position)} />
          ))}
        </div>
      </div>
      <div className="border-t border-border bg-muted/40 px-5 py-[11px] text-[11.5px] leading-snug text-muted-foreground">
        Your share is your AlgoQuarters (stake × time) ÷ the pool's total, applied to the pool's snapshotted power.
      </div>
    </div>
  )
}
