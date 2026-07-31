import { Link } from '@tanstack/react-router'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { Surface } from '@/components/ui/surface'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { useCommittees, useCommitteeVotingPowers } from '@/hooks/queries'
import { usePooledPositions, type PooledPosition } from '@/hooks/fracQueries'
import { formatApprox } from '@/utils/format'
import { cn } from '@/lib/utils'

/**
 * An account's voting power per committee: blocks it produced ("direct") plus its
 * share of any staking pool it belongs to ("pooled").
 *
 * Pooled power is strictly additive here. Direct power keeps coming from
 * `useCommitteeVotingPowers` untouched, so on a network with no frac registry —
 * or for an account in no pool — this renders exactly the direct-only table it
 * replaced: no legend, no breakdown, no "≈", no footnote.
 */

interface Row {
  idBase64Url: string
  periodStart: number
  periodEnd: number
  directVotes: number
  pooled: PooledPosition[]
  pooledVotes: number
  totalVotes: number
}

function LegendDot({ tone }: { tone: 'direct' | 'pooled' }) {
  return <span className={cn('size-2 shrink-0 rounded-full', tone === 'direct' ? 'bg-primary' : 'bg-algo-teal')} />
}

/** One committee's headline: block range on the left, combined total on the right. */
function PowerRow({ row, approximate }: { row: Row; approximate: boolean }) {
  return (
    <Link
      to="/committees/$committeeId"
      params={{ committeeId: row.idBase64Url }}
      className="grid grid-cols-[1fr_auto] items-center gap-2.5 px-5 py-3 transition-colors hover:bg-muted/40"
    >
      <span className="truncate font-mono text-[13px] font-medium text-primary dark:text-algo-teal">
        {row.periodStart.toLocaleString()}–{row.periodEnd.toLocaleString()}
      </span>
      <span className="text-right text-sm font-semibold tabular-nums">
        {approximate ? `≈ ${formatApprox(row.totalVotes)}` : row.totalVotes.toLocaleString()}
      </span>
    </Link>
  )
}

/**
 * Where a row's total comes from — one line per source. Deliberately always
 * visible rather than expand-on-click: the split *is* the point of the card, and
 * a pool member's power is otherwise invisible.
 *
 * Rendered as a sibling of the row's `<Link>`, not inside it, so these lines
 * aren't swallowed into the committee anchor.
 */
function Breakdown({ row, loading }: { row: Row; loading: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 px-5 pb-3">
      <div className="flex items-baseline justify-between gap-3 border-l-2 border-primary/40 pl-3">
        <span className="text-[12px] text-muted-foreground">Direct (blocks produced)</span>
        <span className="shrink-0 text-[12px] font-medium tabular-nums">{row.directVotes.toLocaleString()}</span>
      </div>
      {loading ? (
        <Skeleton className="ml-3 h-3 w-32" />
      ) : (
        row.pooled.map((p) => (
          <div
            key={p.instanceNumId}
            className="flex items-baseline justify-between gap-3 border-l-2 border-algo-teal/60 pl-3"
          >
            <span className="truncate text-[12px] text-muted-foreground">
              {p.instanceName} · {p.sharePct.toFixed(1)}% share
            </span>
            <span className="shrink-0 text-[12px] font-medium tabular-nums text-teal-strong">
              ≈ {formatApprox(p.votes)}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export default function VotingPowerByCommittee({ account }: { account: string }) {
  const { data: directPowers = [], isLoading: loadingDirect } = useCommitteeVotingPowers(account)
  const { data: allCommittees = [] } = useCommittees()

  // `useCommitteeVotingPowers` drops committees where the account produced no
  // blocks, so a pooled-only committee would never appear. Ask about every
  // committee we know of and let the pooled reads decide which ones matter.
  const candidateIds = allCommittees.map((c) => c.idBase64Url)
  const { byCommittee, isPoolMember, isLoading: loadingPooled } = usePooledPositions(account, candidateIds)

  // Commit to the pooled layout on `isPoolMember` (one read) rather than on the
  // amounts, so the card doesn't reflow from direct-only once numbers land.
  const showPooled = isPoolMember

  const rows: Row[] = []
  const seen = new Set<string>()
  for (const c of directPowers) {
    const pooled = byCommittee[c.idBase64Url] ?? []
    const pooledVotes = pooled.reduce((sum, p) => sum + p.votes, 0)
    seen.add(c.idBase64Url)
    rows.push({
      idBase64Url: c.idBase64Url,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      directVotes: c.votingPower,
      pooled,
      pooledVotes,
      totalVotes: c.votingPower + pooledVotes,
    })
  }
  // Pooled-only committees: power held entirely through a pool.
  for (const [idBase64Url, pooled] of Object.entries(byCommittee)) {
    if (seen.has(idBase64Url)) continue
    const meta = allCommittees.find((c) => c.idBase64Url === idBase64Url)
    if (!meta) continue
    const pooledVotes = pooled.reduce((sum, p) => sum + p.votes, 0)
    rows.push({
      idBase64Url,
      periodStart: meta.periodStart,
      periodEnd: meta.periodEnd,
      directVotes: 0,
      pooled,
      pooledVotes,
      totalVotes: pooledVotes,
    })
  }
  rows.sort((a, b) => b.periodStart - a.periodStart)

  // Committee windows overlap (3M blocks advancing 1M at a time), so summing
  // across them is meaningless — "current" is the newest committee.
  const current = rows[0]
  const currentApproximate = showPooled && !!current && current.pooledVotes > 0

  return (
    <div className="flex flex-col">
      <Surface className="overflow-hidden">
        <div className="p-5 pb-3.5">
          <Eyebrow>Voting power by committee</Eyebrow>
          <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">
            {showPooled
              ? 'Total power per period — blocks this account produced plus its share of each staking pool.'
              : "Blocks this account produced in each period's committee window. One block, one vote."}
          </p>
          {showPooled && (
            <div className="mt-2.5 flex items-center gap-4 text-[11.5px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <LegendDot tone="direct" />
                Direct
              </span>
              <span className="flex items-center gap-1.5">
                <LegendDot tone="pooled" />
                Pooled
              </span>
            </div>
          )}
        </div>

        {loadingDirect ? (
          <div className="space-y-2 px-5 pb-5">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyPanel>No committees found.</EmptyPanel>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] border-b border-border px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              <span>Committee</span>
              <span className="text-right">Voting power</span>
            </div>
            {rows.map((row) => (
              <div key={row.idBase64Url} className="border-b border-border">
                <PowerRow row={row} approximate={showPooled && row.pooledVotes > 0} />
                {/* A breakdown only says something when the total is actually split.
                    While pooled amounts are still resolving we don't yet know which
                    rows will split, so show it everywhere until they land. */}
                {showPooled && (row.pooled.length > 0 || loadingPooled) && (
                  <Breakdown row={row} loading={loadingPooled && row.pooled.length === 0} />
                )}
              </div>
            ))}
            {current && (
              <div className="flex items-center justify-between gap-3 bg-muted/40 px-5 py-3.5">
                <span className="text-[12.5px] text-muted-foreground">Current voting power</span>
                <span className="font-display text-[22px] font-bold leading-none tabular-nums text-primary dark:text-algo-teal">
                  {currentApproximate ? `≈ ${formatApprox(current.totalVotes)}` : current.totalVotes.toLocaleString()}
                </span>
              </div>
            )}
          </>
        )}
      </Surface>
      {showPooled && (
        <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">
          These represent your prorated share of pooled staking based on your contributions.{' '}
          <Link
            to="/docs/pooled-voting"
            className="font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
          >
            Learn more
          </Link>
        </p>
      )}
    </div>
  )
}
