import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowRight, Check, ChevronDown } from 'lucide-react'
import { useWallet } from '@txnlab/use-wallet-react'
import { useCommittee, useCommittees, usePeriods, toBase64Url, type CommitteeOption } from '@/hooks/queries'
import { useCommitteePoolVotedAq, useCommitteePools, usePooledPositions, type CommitteePool } from '@/hooks/fracQueries'
import { useIsMobile } from '@/hooks/use-mobile'
import { Avatar, avatarTone } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tag } from '@/components/ui/tag'
import PoolCompositionBar from '@/components/PoolCompositionBar'
import { pctOf, segmentColor } from '@/lib/poolComposition'
import { formatBlockRange, formatCompact } from '@/utils/format'
import { cn } from '@/lib/utils'

// ── Pool kind ────────────────────────────────────────────────────────────────

type PoolKind = 'liquid' | 'reti'

type KindFilter = PoolKind | 'all'

/**
 * Liquid-staking token vs. Réti validator pool.
 *
 * TODO(data): derived from the pool's name, because that is the only descriptive
 * field the registry keeps — `FracInstance` is `{ appId, name, numAccounts,
 * numEscrows }` and nothing in it records what kind of pool an instance wraps.
 * So this is a naming convention, not a fact: a Réti instance that doesn't say
 * "Reti" lands in the liquid bucket. The fix is a `kind` (or a free-form tag) on
 * the instance record, set at `createInstance` — contract work, so a follow-up.
 * Until then the filter is only offered when both buckets are actually populated.
 */
function poolKind(name: string): PoolKind {
  // Fold diacritics first: operators write both "Reti" and "Réti", and \b never
  // matches across the combining mark in the latter.
  const folded = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return /\breti\b/i.test(folded) ? 'reti' : 'liquid'
}

const KIND_LABEL: Record<PoolKind, string> = {
  liquid: 'Liquid staking',
  reti: 'Réti pool',
}

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'liquid', label: 'Liquid' },
  { value: 'reti', label: 'Réti' },
]

/** Headline label — says which slice of the committee the percentage covers. */
const HELD_LABEL: Record<KindFilter, string> = {
  all: 'Voting power held by pools',
  liquid: 'Voting power held by liquid staking',
  reti: 'Voting power held by Réti pools',
}

// ── Committee selector ───────────────────────────────────────────────────────

/**
 * Committee picker. Changing it navigates rather than setting state — a
 * committee's pool composition is its own URL, so it can be linked and shared.
 */
function CommitteeSelector({
  committees,
  selected,
  periodLabels,
  loading,
}: {
  committees: CommitteeOption[]
  selected: CommitteeOption | undefined
  /** Committee id (base64url) → "Period 19" / "Periods 18, 19", when one used it. */
  periodLabels: Map<string, string>
  loading: boolean
}) {
  const navigate = useNavigate()
  // Committees come back newest-first, so the head is the live window.
  const currentId = committees[0]?.idBase64Url

  if (loading && !selected) return <Skeleton className="h-[52px] w-full sm:w-[210px]" />

  return (
    <div className="w-full sm:w-auto">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        Committee
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={committees.length === 0}
          className="group flex min-h-12 w-full items-center justify-between gap-2.5 rounded-md border border-input bg-background px-3.5 py-2 text-left transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-[13px] font-semibold">
              {selected ? formatBlockRange(selected.periodStart, selected.periodEnd) : '—'}
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              {selected ? (periodLabels.get(selected.idBase64Url) ?? 'Not used by a period') : 'No committee'}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-[288px] overflow-y-auto">
          {committees.map((c) => (
            <DropdownMenuItem
              key={c.idBase64Url}
              onSelect={() => navigate({ to: '/pools/$committeeId', params: { committeeId: c.idBase64Url } })}
              className="gap-2.5 px-3 py-2.5"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-[13px] font-semibold text-algo-blue dark:text-algo-teal">
                  {formatBlockRange(c.periodStart, c.periodEnd)}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {periodLabels.get(c.idBase64Url) ?? `${(c.periodEnd - c.periodStart).toLocaleString()} rounds`}
                </span>
              </span>
              {c.idBase64Url === currentId && (
                <Tag tone="teal" className="shrink-0 px-2 py-0.5 text-[10px]">
                  Current
                </Tag>
              )}
              {c.idBase64Url === selected?.idBase64Url && (
                <Check className="size-4 shrink-0 !text-algo-blue dark:!text-algo-teal" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ── Ranked list ──────────────────────────────────────────────────────────────

/**
 * Rows per page. Also the ceiling on how many turnout reads the page issues at
 * once — that one is still per pool, unlike the pool set itself.
 */
const PAGE_SIZE = 25

/**
 * Three columns at every width, but the meaning of the middle one changes: below
 * `sm` the stake meter rides under the pool name (there is no room for a column
 * of its own), above it the meter shares the right-hand column with the figures.
 */
const POOL_ROW_GRID = 'grid grid-cols-[20px_1fr_auto] items-center gap-2.5 sm:grid-cols-[24px_1fr_236px] sm:gap-3.5'

/**
 * A pool's AlgoQuarters. Real committees reach hundreds of millions, which no
 * column width survives in full, so those abbreviate — the exact figure stays on
 * the row's title. Design-scale numbers (a few hundred thousand) print in full.
 */
function formatAq(aq: number): string {
  return aq >= 1_000_000 ? formatCompact(aq) : aq.toLocaleString()
}

/** Stake meter, scaled against the largest pool in the committee. */
function PoolMeter({ pct, color, className }: { pct: number; color: string; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
    </div>
  )
}

/**
 * A row's view of a pool. `aq`/`stakers` are narrowed from {@link CommitteePool}:
 * the hook reports 0 for a pool with no AlgoQuarters ledger, the row wants that
 * distinguished from a real zero.
 */
interface PoolRowData extends Omit<CommitteePool, 'aq'> {
  rank: number
  kind: PoolKind
  color: string
  /** Share of the committee's total votes. Undefined until the committee loads. */
  share: number | undefined
  /** Meter fill, relative to the strongest pool. */
  meterPct: number
  /** Window-scoped staker count; falls back to the registry-wide roster. */
  stakers: number
  /** AlgoQuarters behind this pool's power. Undefined when no ledger is open. */
  aq: number | undefined
  /** Share of that stake that has cast an internal ballot, 0–100. */
  votedPct: number | undefined
  /** The connected account holds a share of this pool. */
  yours: boolean
}

/** ≥50% green, ≥40% neutral, below that amber — turnout worth flagging. */
function turnoutClass(pct: number): string {
  if (pct >= 50) return 'text-success-strong dark:text-success'
  if (pct >= 40) return 'text-muted-foreground'
  return 'text-warning-strong'
}

function PoolRow({ pool, showKind }: { pool: PoolRowData; showKind: boolean }) {
  const meta: ReactNode[] = [
    // Dropped on a phone: it is the least load-bearing of the four and the row is
    // tight there. Decided in JS rather than with `hidden sm:inline` because the
    // parts are `·`-separated, and a CSS-hidden first part strands its separator.
    showKind ? KIND_LABEL[pool.kind] : null,
    pool.share === undefined ? null : `${pool.share.toFixed(1)}% of committee`,
    `${pool.stakers.toLocaleString()} members`,
    pool.votedPct === undefined ? null : (
      <span key="voted" className={turnoutClass(pool.votedPct)}>
        {pool.votedPct.toFixed(0)}% voted
      </span>
    ),
  ].filter((part) => part !== null)

  return (
    <div
      className={cn(
        POOL_ROW_GRID,
        'border-b border-border px-3.5 py-3 last:border-0 sm:px-4.5',
        pool.yours && 'shadow-[inset_2px_0_0_var(--algo-teal)]',
      )}
    >
      <span className="font-display text-[13px] font-bold tabular-nums text-muted-foreground sm:text-[14px]">
        {pool.rank}
      </span>

      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={pool.name} tone={avatarTone(pool.name)} size={28} className="hidden sm:inline-flex" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold sm:text-sm">{pool.name}</span>
            {pool.yours && (
              <Tag tone="teal" className="shrink-0 px-2 py-0.5 text-[10px]">
                yours
              </Tag>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground sm:text-[11.5px]">
            {meta.map((part, i) => (
              <span key={i} className="contents">
                {i > 0 && <span aria-hidden>·</span>}
                {part}
              </span>
            ))}
          </div>
          {/* Below `sm` there is no meter column, so it rides under the name. */}
          <PoolMeter pct={pool.meterPct} color={pool.color} className="mt-1.5 h-1 sm:hidden" />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 sm:gap-2.5">
        <PoolMeter pct={pool.meterPct} color={pool.color} className="hidden h-1.5 flex-1 sm:block" />
        <span className="shrink-0 text-right sm:w-[92px]">
          <span
            className="block whitespace-nowrap text-[13.5px] font-semibold tabular-nums"
            title={pool.aq === undefined ? undefined : `${pool.aq.toLocaleString()} AlgoQuarters`}
          >
            {pool.aq === undefined ? '—' : formatAq(pool.aq)}
            {/* The unit is carried by the footnote on a phone, where it costs a
                third of the column. */}
            {pool.aq !== undefined && <span className="hidden sm:inline"> AQ</span>}
          </span>
          <span className="mt-0.5 block text-[10.5px] tabular-nums text-muted-foreground sm:text-[11px]">
            {pool.votes.toLocaleString()} votes
          </span>
        </span>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * Every staking pool holding voting power in one committee, ranked.
 *
 * The committee is the route (`/pools/$committeeId`), not component state, so a
 * composition is linkable. Everything else resolves independently and fills in:
 * the pool set and its gGov power come from the frac registry, the AlgoQuarters
 * behind that power is a second read per pool, and turnout a third — so the list
 * is never blocked on its slowest column. See `hooks/fracQueries.ts`.
 */
export default function Pools() {
  const { committeeId } = useParams({ strict: false })
  const { activeAddress } = useWallet()
  const isMobile = useIsMobile()
  const [kind, setKind] = useState<KindFilter>('all')
  const [page, setPage] = useState(0)

  const { data: committees = [], isLoading: loadingCommittees } = useCommittees()
  const { data: periods = [] } = usePeriods()
  const { data: committee, isLoading: loadingCommittee } = useCommittee(committeeId)
  const { pools, isLoading: loadingPools, isError, fracEnabled } = useCommitteePools(committeeId)

  // Map each committee → the period(s) that used its window, mirroring the
  // committees index. Doubles as the turnout period: pooled ballots are cast per
  // period, so "how much of this pool voted" needs one to be about.
  const { periodLabels, turnoutPeriodId } = useMemo(() => {
    const byCommittee = new Map<string, number[]>()
    for (const p of periods) {
      const id = toBase64Url(p.period.committeeId)
      const list = byCommittee.get(id) ?? []
      list.push(p.id)
      byCommittee.set(id, list)
    }
    const periodLabels = new Map<string, string>()
    for (const [id, list] of byCommittee) {
      list.sort((a, b) => a - b)
      periodLabels.set(id, list.length === 1 ? `Period ${list[0]}` : `Periods ${list.join(', ')}`)
    }
    // Turnout period: the newest period on this committee whose voting has
    // actually opened. A committee can back several periods, and defaulting to
    // the newest would report a flat 0% for one that hasn't started — which reads
    // as "nobody voted" rather than "there was nothing to vote on".
    const started = new Set(
      periods.filter((p) => p.ready && p.period.votingStart * 1000 <= Date.now()).map((p) => p.id),
    )
    const used = (committeeId ? (byCommittee.get(committeeId) ?? []) : []).filter((id) => started.has(id))
    return { periodLabels, turnoutPeriodId: used[used.length - 1] }
  }, [periods, committeeId])

  const selected = useMemo(
    () => committees.find((c) => c.idBase64Url === committeeId) ?? (committeeId ? committee : undefined) ?? undefined,
    [committees, committee, committeeId],
  )

  const hasBothKinds = useMemo(() => new Set(pools.map((p) => poolKind(p.name))).size > 1, [pools])
  // A filter the current committee can't satisfy would strand the page on an
  // empty list after navigating between committees.
  const activeKind: KindFilter = hasBothKinds ? kind : 'all'

  const shown = useMemo(
    () => pools.filter((p) => activeKind === 'all' || poolKind(p.name) === activeKind),
    [pools, activeKind],
  )
  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const start = page * PAGE_SIZE
  // Turnout is a read *per pool*, so it is asked for one page at a time. The pool
  // set and its stake are not — those arrive together from `useCommitteePools`.
  const paged = useMemo(() => shown.slice(start, start + PAGE_SIZE), [shown, start])

  const { byInstance: votedAqByInstance } = useCommitteePoolVotedAq(paged, turnoutPeriodId)
  // Which of these pools the connected wallet is in. No wallet, no query.
  const { byCommittee: myPositions } = usePooledPositions(activeAddress, committeeId ? [committeeId] : [])
  const myInstances = useMemo(
    () => new Set((committeeId ? (myPositions[committeeId] ?? []) : []).map((p) => p.instanceNumId)),
    [myPositions, committeeId],
  )

  const rows: PoolRowData[] = useMemo(() => {
    // Meters scale against the whole filtered set, not the page, so bar lengths
    // stay comparable when you page through.
    const maxVotes = Math.max(0, ...shown.map((p) => p.votes))
    return paged.map((pool, i) => {
      const votedAq = votedAqByInstance[pool.instanceNumId]
      return {
        ...pool,
        rank: start + i + 1,
        kind: poolKind(pool.name),
        color: segmentColor(start + i),
        share: pctOf(pool.votes, committee?.totalVotes),
        meterPct: maxVotes > 0 ? (pool.votes / maxVotes) * 100 : 0,
        // No ledger open means nobody's stake is recorded for this window, so the
        // roster is the only member count there is.
        stakers: pool.aq > 0 ? pool.stakers : pool.members,
        aq: pool.aq > 0 ? pool.aq : undefined,
        votedPct: pool.aq > 0 && votedAq !== undefined ? (votedAq / pool.aq) * 100 : undefined,
        yours: myInstances.has(pool.instanceNumId),
      }
    })
  }, [shown, paged, start, votedAqByInstance, committee?.totalVotes, myInstances])

  const shownVotes = shown.reduce((sum, p) => sum + p.votes, 0)
  const shownShare = loadingPools ? undefined : pctOf(shownVotes, committee?.totalVotes)
  // Window-scoped where a pool has an AlgoQuarters ledger, its registry-wide
  // roster where it does not — the same rule the rows use, so the total is the
  // sum of what is on screen.
  const shownMembers = shown.reduce((sum, p) => sum + (p.aq > 0 ? p.stakers : p.members), 0)
  const loadingShare = loadingPools || loadingCommittee

  // Restart at the first page when the committee or the filter changes — this
  // component stays mounted across `:committeeId` changes.
  useEffect(() => {
    setPage(0)
  }, [committeeId, activeKind])

  // Clamp if the list shrinks under us (a background refetch), so we never render
  // an out-of-range, empty page.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1))
  }, [totalPages])

  const rosterLabel = (
    <span className="whitespace-nowrap text-[12.5px] font-semibold text-muted-foreground">
      {shown.length.toLocaleString()} {shown.length === 1 ? 'pool' : 'pools'} · {shownMembers.toLocaleString()} members
    </span>
  )

  const header = (
    <>
      <Eyebrow className="text-algo-blue dark:text-algo-teal">Pooled voting</Eyebrow>
      <h1 className="mt-2 font-display text-[28px] font-bold leading-[1.04] sm:text-[34px]">Staking pools</h1>
      <p className="mt-2.5 max-w-[66ch] text-[13.5px] leading-[1.55] text-muted-foreground sm:text-[15px]">
        Liquid staking tokens and staking pools produce blocks from shared accounts. Each user's contribution to the
        pools below is used to calculate a prorated share of the pool's voting power, which users can then vote with.
      </p>
      <Link
        to="/docs/pooled-voting"
        className="mt-3 inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-algo-blue transition-colors hover:opacity-80 dark:text-algo-teal"
      >
        Voting from a staking pool
        <ArrowRight className="size-3.5" />
      </Link>
    </>
  )

  // A network with no frac registry has no pooled voting at all — the same gate
  // every other pooled surface uses, except this page exists to talk about it and
  // so says so rather than rendering nothing.
  if (!fracEnabled) {
    return (
      <div className="mx-auto max-w-[940px]">
        {header}
        <EmptyPanel className="mt-7">Pooled voting is not available on this network.</EmptyPanel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[940px]">
      {header}

      {/* Composition — how much of the committee is pooled, and in which pools. */}
      <div className="mt-6 flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {HELD_LABEL[activeKind]}
          </div>
          {loadingShare ? (
            <Skeleton className="mt-2 h-8 w-24" />
          ) : (
            <div className="mt-2 font-display text-[28px] font-bold leading-none tabular-nums text-teal-strong sm:text-[34px]">
              {shownShare === undefined ? '—' : `${shownShare.toFixed(1)}%`}
            </div>
          )}
        </div>
        <CommitteeSelector
          committees={committees}
          selected={selected}
          periodLabels={periodLabels}
          loading={loadingCommittees}
        />
      </div>

      {isError ? (
        <EmptyPanel className="mt-6">Pooled voting data is unavailable right now.</EmptyPanel>
      ) : !loadingPools && pools.length === 0 ? (
        <EmptyPanel className="mt-6">
          No pool has synced this committee, so none of its voting power is pooled.
        </EmptyPanel>
      ) : (
        <>
          {/* The whole filtered set, not the page — the bar is the committee's
              composition, and paging through the list must not redraw it. */}
          <PoolCompositionBar
            className="mt-4"
            pools={shown}
            totalVotes={committee?.totalVotes}
            loading={loadingPools}
            loadingShare={loadingShare}
            remainderLabel={activeKind === 'all' ? 'Direct voters' : 'Other voters'}
            barClassName="h-2.5 sm:h-3.5"
          />

          {/* Ranked list. The roster count sits beside the heading when there is
              room, and drops onto the filter's row when there isn't. */}
          <div className="mt-7 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 className="whitespace-nowrap font-display text-[19px] font-bold sm:text-xl">
                Ranked by voting power
              </h2>
              {!loadingPools && <span className="hidden sm:block">{rosterLabel}</span>}
            </div>
            <div className="flex w-full items-center justify-between gap-3 sm:w-auto">
              {!loadingPools && <span className="sm:hidden">{rosterLabel}</span>}
              {hasBothKinds && (
                <Tabs value={kind} onValueChange={(v) => setKind(v as KindFilter)} className="ml-auto shrink-0">
                  <TabsList>
                    {FILTERS.map((f) => (
                      <TabsTrigger key={f.value} value={f.value}>
                        {f.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
            </div>
          </div>

          <div className="mt-3.5 overflow-hidden rounded-xl border border-border bg-card">
            {loadingPools ? (
              <div className="flex flex-col gap-2 p-3.5 sm:p-4.5">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : (
              <>
                {rows.map((pool) => (
                  <PoolRow key={pool.instanceNumId} pool={pool} showKind={!isMobile} />
                ))}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-2 bg-muted/40 px-3.5 py-3 sm:gap-3.5 sm:px-4.5">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      ← Previous
                    </button>
                    <span className="text-[13px] text-muted-foreground">
                      Page <strong className="text-foreground tabular-nums">{page + 1}</strong> of{' '}
                      <span className="tabular-nums">{totalPages}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[13px] font-semibold transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <p className="mt-3.5 text-xs leading-[1.5] text-muted-foreground">
            Stake is measured in AlgoQuarters — 1 ALGO held in the pool for the full{' '}
            {selected ? (selected.periodEnd - selected.periodStart).toLocaleString() : '3,000,000'}-block window equals
            1 AQ.{' '}
            {turnoutPeriodId !== undefined && (
              <>Turnout is the share of that stake that voted in Period {turnoutPeriodId}. </>
            )}
            {totalPages > 1 && (
              <>
                Turnout is read per pool, so it resolves for the page you are on — showing{' '}
                <span className="tabular-nums">
                  {start + 1}–{Math.min(start + PAGE_SIZE, shown.length)}
                </span>{' '}
                of <span className="tabular-nums">{shown.length.toLocaleString()}</span>.
              </>
            )}
          </p>
        </>
      )}
    </div>
  )
}
