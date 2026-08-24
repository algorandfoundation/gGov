import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowRight, ChevronDown, Download } from 'lucide-react'
import { useWallet } from '@txnlab/use-wallet-react'
import { useCommittee, useCommittees, usePeriod, usePeriodBody, useTopicBodies } from '@/hooks/queries'
import {
  useCommitteePools,
  useFracInstanceCommittees,
  usePoolMemberRecords,
  usePoolMembers,
  usePooledPositions,
  usePoolProtocolApps,
  usePoolVoteCache,
  votedAqOf,
  type PoolMember,
} from '@/hooks/fracQueries'
import { useCommitteePeriods } from '@/hooks/useCommitteePeriods'
import { AccountAvatar } from '@/components/AccountAvatar'
import AppExplorerLink from '@/components/AppExplorerLink'
import PoolCommitteeSelector from '@/components/PoolCommitteeSelector'
import SidebarLayout from '@/components/SidebarLayout'
import { Avatar, avatarTone } from '@/components/ui/avatar'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { Tag } from '@/components/ui/tag'
import { KIND_LABEL, poolKind } from '@/lib/poolKind'
import { pctOf } from '@/lib/poolComposition'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { csvDocument, downloadBlob } from '@/utils/download'
import { formatApprox, formatBlockRange, formatCompact } from '@/utils/format'
import { periodTerms, plural } from '@/utils/periodTerms'
import { periodStatus } from '@/utils/time'
import { tallyBallot } from '@/utils/vote'
import { cn } from '@/lib/utils'

/**
 * Members per page. Well under the committee leaderboard's 25, because every row
 * here costs a vote-record read: the page is one simulate group of 16 calls (see
 * `usePoolMemberRecords`), and 10 keeps a page inside one round-trip with room
 * for the group's other work.
 */
const PAGE_SIZE = 10

/** Ballot items shown before "Show all N items". */
const RECORD_PREVIEW = 5

/**
 * Support / Veto / Abstain, in the order every table on this page renders them.
 * The same three tints `AccountVoteRecord.sentimentTone` gives those sentiments,
 * so a pooled ballot reads the same as a direct one.
 */
const SUPPORT_TONE = 'bg-success'
const VETO_TONE = 'bg-algo-orange'
const ABSTAIN_TONE = 'bg-algo-navy-40'

/** A pool's AlgoQuarters — abbreviated past a million, where no column survives it. */
function formatAq(aq: number): string {
  return aq >= 1_000_000 ? formatCompact(aq) : aq.toLocaleString()
}

// ── Voting record ────────────────────────────────────────────────────────────

/** One ballot item, as this pool's members scored it. */
interface RecordItem {
  topicIndex: number
  name: string
  /** "Topic", or "Candidate · <election>" on an election ballot. */
  kind: string
  /** Shares of the pool's whole stake, 0–100 and summing to 100. */
  supportPct: number
  vetoPct: number
  abstainPct: number
  /**
   * AlgoQuarters actually cast on this item. 0 means no member voted at all —
   * distinct from a pool whose members all cast an explicit Abstain, and from
   * either side winning. `abstainPct` cannot tell those apart, because stake that
   * never voted is folded into it (which is what the contract does when it splits
   * the pool's power).
   */
  castAq: number
  /** Some of that cast weight went to Support or Veto rather than Abstain. */
  decided: boolean
}

/** Only above `sm`; a phone gets the stacked layout in {@link RecordRow}. */
const RECORD_GRID = 'grid grid-cols-[1fr_74px_62px_70px] gap-2.5'

/**
 * The same four columns inside an expanded member row, where the figures are
 * single dots rather than percentages — so the three of them can be much
 * narrower, which is what buys the item name room on a phone.
 */
const MEMBER_VOTE_GRID = 'grid grid-cols-[1fr_34px_34px_34px] gap-2 sm:grid-cols-[1fr_74px_62px_70px] sm:gap-2.5'

function RecordBar({ item, className }: { item: RecordItem; className?: string }) {
  return (
    <div className={cn('flex overflow-hidden rounded-full bg-muted', className)}>
      <span className={SUPPORT_TONE} style={{ width: `${item.supportPct}%` }} />
      <span className={VETO_TONE} style={{ width: `${item.vetoPct}%` }} />
      <span className={ABSTAIN_TONE} style={{ width: `${item.abstainPct}%` }} />
    </div>
  )
}

/**
 * What this item's numbers say happened — which is not always "a side won". A
 * pool nobody voted in reads 0 / 0 / 100, and calling that "Pool voted Support"
 * (the old `support >= veto` default) reported a decision that was never taken.
 */
function itemOutcome(item: RecordItem, live: boolean): { text: string; tone: string } {
  const muted = 'text-muted-foreground'
  if (item.castAq === 0) {
    return { text: live ? 'Live · no votes yet' : 'No votes cast', tone: muted }
  }
  if (!item.decided) {
    return { text: live ? 'Live · abstaining' : 'Pool abstained', tone: muted }
  }
  const leading = item.supportPct >= item.vetoPct ? 'Support' : 'Veto'
  if (live) return { text: `Live · leaning ${leading}`, tone: muted }
  return {
    text: `Pool voted ${leading}`,
    tone: leading === 'Support' ? 'text-success-strong' : 'text-algo-orange',
  }
}

function RecordRow({ item, periodId, live }: { item: RecordItem; periodId: number; live: boolean }) {
  const outcome = itemOutcome(item, live)
  const heading = (
    <>
      <Link
        to="/vote/period/$periodId/results"
        params={{ periodId: String(periodId) }}
        className="text-[13.5px] font-medium text-algo-blue hover:underline dark:text-algo-teal sm:text-[13.5px]"
      >
        {item.name}
      </Link>
      <span className="mt-0.5 block text-[11px] text-muted-foreground">
        {item.kind} · <span className={outcome.tone}>{outcome.text}</span>
      </span>
    </>
  )

  return (
    <div className="border-b border-border px-3.5 py-3 last:border-0 tabular-nums">
      {/* Phone: three narrow percentage columns leave the item name unreadable,
          so the figures move under a full-width bar instead. */}
      <div className="sm:hidden">
        {heading}
        <RecordBar item={item} className="mt-2 h-1.5 w-full" />
        <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] font-semibold">
          <span className="text-success-strong">Support {item.supportPct.toFixed(0)}%</span>
          <span className="text-algo-orange">Veto {item.vetoPct.toFixed(0)}%</span>
          <span className="text-muted-foreground">Abstain {item.abstainPct.toFixed(0)}%</span>
        </div>
      </div>

      <div className={cn(RECORD_GRID, 'hidden items-center sm:grid')}>
        <span className="min-w-0">
          {heading}
          <RecordBar item={item} className="mt-[7px] h-[5px] w-full max-w-[220px]" />
        </span>
        <span className="text-right text-[13px] text-success-strong">{item.supportPct.toFixed(0)}%</span>
        <span className="text-right text-[13px] text-algo-orange">{item.vetoPct.toFixed(0)}%</span>
        <span className="text-right text-[13px] text-muted-foreground">{item.abstainPct.toFixed(0)}%</span>
      </div>
    </div>
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * Six columns on tablet and up. Below `sm` the three figure columns are dropped —
 * stake, share and status ride under the account name instead — so the grid is
 * the three that remain, not six with holes in it.
 */
const MEMBER_GRID = 'grid grid-cols-[22px_1fr_16px] items-center gap-2.5 sm:grid-cols-[26px_1fr_96px_64px_92px_18px]'

/** How a member scored one item: the option its stake landed on, or no vote at all. */
type MemberChoice = 'support' | 'veto' | 'abstain'

/**
 * One cell of the member's per-item vote: a filled dot under the option its stake
 * landed on, hollow ones elsewhere.
 *
 * The colour and the column are the whole signal visually, and neither survives
 * into assistive tech, so the selected dot carries the option's name as text and
 * the unselected ones are hidden outright — three "not selected" announcements
 * per row would bury the one that matters.
 */
function ChoiceDot({ on, tone, label }: { on: boolean; tone: string; label: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('inline-block size-[9px] rounded-full', on ? tone : 'border border-input bg-muted')}
      />
      {on && <span className="sr-only">{label}</span>}
    </>
  )
}

interface MemberRowData extends PoolMember {
  rank: number
  /** Share of the pool's stake, 0–100. */
  share: number
  /** Approximate gGov votes this stake carries — see `hooks/fracQueries.ts`. */
  votes: number
  /** One entry per shown ballot item, aligned with `items`. Empty when not voted. */
  choices: MemberChoice[]
  voted: boolean
  /** Whether this is one of the connected wallet's accounts. */
  yours: boolean
}

function MemberRow({
  member,
  items,
  periodLabel,
  ballotNote,
  expanded,
  onToggle,
  recordsLoading,
  recordsError,
}: {
  member: MemberRowData
  items: RecordItem[]
  /** "Period 19", or undefined when no period has opened on this committee. */
  periodLabel: string | undefined
  /** What this member's vote figure is about, article and all — see the page body. */
  ballotNote: string
  expanded: boolean
  onToggle: () => void
  recordsLoading: boolean
  /** The vote records could not be read — absence means "unknown", not "did not vote". */
  recordsError: boolean
}) {
  const { data: name } = useAddressName(member.address)
  const label = name ?? ellipseAddress(member.address, 5)

  return (
    <div
      className={cn('border-b border-border last:border-0', member.yours && 'shadow-[inset_2px_0_0_var(--algo-teal)]')}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          MEMBER_GRID,
          'w-full px-3.5 py-3 text-left transition-colors hover:bg-muted/40 sm:px-4',
          expanded && 'bg-muted/40',
        )}
      >
        <span className="font-display text-[13px] font-bold tabular-nums text-muted-foreground">{member.rank}</span>

        <span className="flex min-w-0 items-center gap-2.5">
          <AccountAvatar address={member.address} name={name} size={24} className="hidden shrink-0 sm:inline-flex" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className={cn('truncate text-[12.5px]', !name && 'font-mono')}>{label}</span>
              {member.yours && (
                <Tag tone="teal" className="shrink-0 px-2 py-0.5 text-[10px]">
                  you
                </Tag>
              )}
            </span>
            {/* Below `sm` the three figure columns collapse into this line. */}
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground sm:hidden">
              <span>{formatAq(member.aq)} AQ</span>
              <span aria-hidden>·</span>
              <span>{member.share.toFixed(2)}%</span>
              <span aria-hidden>·</span>
              <span className={member.voted && !recordsError ? 'text-success-strong' : undefined}>
                {recordsLoading ? '…' : recordsError ? 'Unavailable' : member.voted ? 'Voted' : 'Not voted'}
              </span>
            </span>
          </span>
        </span>

        <span
          className="hidden text-right text-[13px] tabular-nums sm:block"
          title={`${member.aq.toLocaleString()} AlgoQuarters`}
        >
          {formatAq(member.aq)} AQ
        </span>
        <span className="hidden text-right text-[13px] tabular-nums text-muted-foreground sm:block">
          {member.share.toFixed(2)}%
        </span>
        <span
          className={cn(
            'hidden text-right text-[12.5px] sm:block',
            member.voted && !recordsError ? 'text-success-strong' : 'text-muted-foreground',
          )}
        >
          {recordsLoading ? '…' : recordsError ? 'Unavailable' : member.voted ? 'Voted' : 'Not voted'}
        </span>
        <ChevronDown
          className={cn('size-3.5 text-muted-foreground transition-transform duration-150', expanded && 'rotate-180')}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="bg-muted/40 px-3.5 pb-4 pt-1 sm:pl-[52px] sm:pr-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5">
            <Link
              to="/account/$address"
              params={{ address: member.address }}
              className="text-[12.5px] font-semibold text-algo-blue hover:underline dark:text-algo-teal"
            >
              View account
            </Link>
            <span className="text-[12px] tabular-nums text-muted-foreground">
              ≈ {formatApprox(member.votes)} {ballotNote}
            </span>
          </div>

          {/* Only with a ballot to speak of: before a period opens there is nothing this
              account could have voted on, and the empty-items panel below says so. */}
          {!member.voted && periodLabel !== undefined && (
            <p className="pb-2.5 text-[12.5px] leading-[1.5] text-muted-foreground">
              This account has not voted on the {periodLabel} ballot, so its stake is counted as Abstain on every item.
            </p>
          )}

          {items.length === 0 ? (
            <EmptyPanel>This ballot has no items.</EmptyPanel>
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-card">
              <div
                className={cn(
                  MEMBER_VOTE_GRID,
                  'border-b border-border px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground sm:px-3.5 sm:text-[10px]',
                )}
              >
                <span>Item</span>
                <span className="text-center">Sup</span>
                <span className="text-center">Veto</span>
                <span className="text-center">Abs</span>
              </div>
              {items.map((item, i) => {
                const choice = member.choices[i] ?? 'abstain'
                return (
                  <div
                    key={item.topicIndex}
                    className={cn(
                      MEMBER_VOTE_GRID,
                      'items-center border-b border-border px-3 py-2.5 last:border-0 sm:px-3.5',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{item.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.kind}</span>
                    </span>
                    <span className="text-center">
                      <ChoiceDot on={choice === 'support'} tone={SUPPORT_TONE} label="Support" />
                    </span>
                    <span className="text-center">
                      <ChoiceDot on={choice === 'veto'} tone={VETO_TONE} label="Veto" />
                    </span>
                    <span className="text-center">
                      <ChoiceDot on={choice === 'abstain'} tone={ABSTAIN_TONE} label="Abstain" />
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sidebar cards ────────────────────────────────────────────────────────────

function SidebarCard({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className={cn('rounded-xl border bg-card p-[17px]', accent ? 'border-algo-teal/55 shadow-sm' : 'border-border')}
    >
      <div className="font-display text-[15px] font-bold">{title}</div>
      {children}
    </div>
  )
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[12.5px] font-semibold">{children}</span>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * One staking pool's standing in one committee: the stake behind its voting
 * power, how its members scored the ballot, and who those members are.
 *
 * The committee is the route (`/pools/$committeeId/$instanceNumId`) because every
 * figure above the voting record is window-scoped — a pool's stake, members and
 * share only mean anything against one committee. The ballot is period-scoped and
 * carried in `?period=`, so a committee that backed several periods can show each
 * one at its own URL and the back button steps through them.
 *
 * Reads fan out rather than chaining: the pool's identity and power come from the
 * committee-wide registry read the pools index already made (so arriving from it
 * costs nothing), its tally is one read shared with that index's turnout column,
 * and the member list is the one genuinely expensive part — see `usePoolMembers`.
 */
export default function PoolDetail() {
  const { committeeId, instanceNumId: instanceParam } = useParams({ strict: false })
  const search = useSearch({ strict: false }) as { period?: number }
  const navigate = useNavigate()
  const { activeAddress } = useWallet()
  const instanceNumId = Number(instanceParam)

  const [page, setPage] = useState(0)
  const [openMember, setOpenMember] = useState<string | null>(null)
  const [showAllItems, setShowAllItems] = useState(false)

  const { data: committees = [], isLoading: loadingCommittees } = useCommittees()
  const { data: committee, isLoading: loadingCommittee } = useCommittee(committeeId)
  const { pools, isLoading: loadingPools, isError: poolsError, fracEnabled } = useCommitteePools(committeeId)
  const { periodLabels, byCommittee, startedOn } = useCommitteePeriods()

  const pool = useMemo(() => pools.find((p) => p.instanceNumId === instanceNumId), [pools, instanceNumId])

  // Which ballot the voting record is about: the requested period when this
  // committee actually ran it, else the newest that opened on this window.
  const started = startedOn(committeeId)
  const periodId =
    search.period !== undefined && started.includes(search.period) ? search.period : started[started.length - 1]
  const periodLabel = periodId === undefined ? undefined : `Period ${periodId}`
  /**
   * The tail every vote figure on this page carries. A committee can have an ingested
   * AlgoQuarters ledger before any period opens on it, and then there is no ballot to name —
   * so the phrase changes rather than dropping a placeholder into "on the … ballot".
   */
  const ballotNote = periodLabel === undefined ? 'votes in this committee' : `votes on the ${periodLabel} ballot`

  const { data: period } = usePeriod(periodId ?? 0, periodId !== undefined)
  const { data: periodBody } = usePeriodBody(periodId ?? 0, periodId !== undefined)
  const { data: topicBodies = [] } = useTopicBodies(periodId ?? 0, period?.topics.length ?? 0)
  // Memoised because it is a dependency of the ballot below, and `periodTerms`
  // builds a fresh object for an election period.
  const terms = useMemo(() => periodTerms(periodBody?.elect), [periodBody?.elect])

  const { cache, isLoading: loadingCache, isError: cacheError } = usePoolVoteCache(instanceNumId, periodId)
  const {
    members,
    isLoading: loadingMembers,
    isError: membersError,
  } = usePoolMembers(instanceNumId, pool?.committeeNumId, committeeId)
  // The application(s) the pool's escrows belong to — see `usePoolProtocolApps`.
  const { appIds: protocolApps, isLoading: loadingProtocolApps } = usePoolProtocolApps(instanceNumId)

  // The connected wallet's own stake here, if any. Same query the pools index
  // makes to flag "yours", so it is already warm on arrival.
  const { byCommittee: myPositions } = usePooledPositions(activeAddress, committeeId ? [committeeId] : [])
  const myPosition = useMemo(
    () => (committeeId ? myPositions[committeeId] : undefined)?.find((p) => p.instanceNumId === instanceNumId),
    [myPositions, committeeId, instanceNumId],
  )

  // "Voting since": the oldest committee this pool ever synced with power in it.
  // One read over every committee, batched 63 ids per call by the SDK.
  const allCommitteeIds = useMemo(() => committees.map((c) => c.idBase64Url), [committees])
  const { byInstance: syncedCommittees } = useFracInstanceCommittees(
    Number.isInteger(instanceNumId) && instanceNumId > 0 ? [instanceNumId] : [],
    allCommitteeIds,
  )
  const votingSince = useMemo(() => {
    const synced = syncedCommittees[instanceNumId]
    if (!synced) return undefined
    // `committees` is newest-first, so the last one the pool synced is its first.
    const oldest = [...committees].reverse().find((c) => synced[c.idBase64Url] !== undefined)
    if (!oldest) return undefined
    // The *first* ballot on that window, not the window's whole label: a committee
    // that backed three periods is labelled "Periods 1, 2, 3", which reads as
    // nonsense after "Voting since". A window no period used has only its rounds.
    const first = byCommittee.get(oldest.idBase64Url)?.[0]
    return first === undefined ? formatBlockRange(oldest.periodStart, oldest.periodEnd) : `Period ${first}`
  }, [syncedCommittees, instanceNumId, committees, byCommittee])

  const selected = useMemo(
    () => committees.find((c) => c.idBase64Url === committeeId) ?? committee ?? undefined,
    [committees, committee, committeeId],
  )

  // ── Derived: the ballot as this pool scored it ────────────────────────────
  //
  // `cache.internal` is [topic][option] in AlgoQuarters. Percentages are shares
  // of the pool's *whole* stake, not of what voted: stake that never voted is
  // counted as Abstain, which is exactly what the contract does when it splits
  // the pool's gGov power across the answers.
  const poolAq = pool && pool.aq > 0 ? pool.aq : undefined
  const votedAq = cache ? votedAqOf(cache.internal) : undefined

  const items: RecordItem[] = useMemo(() => {
    if (!period || !cache || !poolAq) return []
    return period.topics.map(([options], topicIndex) => {
      const tallies = cache.internal[topicIndex] ?? []
      const { yes, no, abstain } = tallyBallot(options, tallies)
      const cast = yes + no + abstain
      // Whatever this topic did not receive is stake that did not vote.
      const silent = Math.max(0, poolAq - cast)
      const title = topicBodies[topicIndex]?.title?.trim()
      return {
        topicIndex,
        name: title || `${terms.Item} ${topicIndex + 1}`,
        kind: terms.isElection ? `${terms.Item} · ${periodBody?.title ?? 'Election'}` : terms.Item,
        supportPct: (yes / poolAq) * 100,
        vetoPct: (no / poolAq) * 100,
        abstainPct: ((abstain + silent) / poolAq) * 100,
        castAq: cast,
        decided: yes > 0 || no > 0,
      }
    })
  }, [period, cache, poolAq, topicBodies, terms, periodBody?.title])

  const shownItems = showAllItems ? items : items.slice(0, RECORD_PREVIEW)

  // ── Derived: members, one page at a time ──────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(members.length / PAGE_SIZE))
  const start = page * PAGE_SIZE
  const paged = useMemo(() => members.slice(start, start + PAGE_SIZE), [members, start])
  const pagedIds = useMemo(() => paged.map((m) => m.accountId), [paged])
  const {
    byAccountId: records,
    isLoading: loadingRecords,
    isError: recordsError,
  } = usePoolMemberRecords(instanceNumId, periodId, pagedIds)

  const myAddresses = useMemo(() => new Set(activeAddress ? [activeAddress] : []), [activeAddress])

  const rows: MemberRowData[] = useMemo(
    () =>
      paged.map((member, i) => {
        const record = records[member.accountId]
        const choices = shownItems.map((item): MemberChoice => {
          const tallies = record?.topicVotes[item.topicIndex]
          const options = period?.topics[item.topicIndex]?.[0]
          if (!tallies || !options) return 'abstain'
          const { yes, no, abstain } = tallyBallot(options, tallies)
          if (yes >= no && yes >= abstain && yes > 0) return 'support'
          if (no >= abstain && no > 0) return 'veto'
          return 'abstain'
        })
        return {
          ...member,
          rank: start + i + 1,
          share: poolAq ? (member.aq / poolAq) * 100 : 0,
          votes: poolAq && pool ? (member.aq / poolAq) * pool.votes : 0,
          choices,
          voted: record !== undefined,
          yours: myAddresses.has(member.address),
        }
      }),
    [paged, records, shownItems, period, start, poolAq, pool, myAddresses],
  )

  // Restart at the first page, and drop any open row, when the pool, committee or
  // ballot changes — this component stays mounted across those param changes.
  useEffect(() => {
    setPage(0)
    setOpenMember(null)
    setShowAllItems(false)
  }, [committeeId, instanceNumId, periodId])

  // Clamp if the list shrinks under us (a background refetch).
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1))
  }, [totalPages])

  const handleExport = () => {
    if (!pool) return
    const csv = csvDocument(
      ['rank', 'account', 'algoquarters', 'share_pct', 'approx_votes'],
      members.map((m, i) => [
        i + 1,
        m.address,
        m.aq,
        poolAq ? ((m.aq / poolAq) * 100).toFixed(4) : '',
        poolAq ? ((m.aq / poolAq) * pool.votes).toFixed(2) : '',
      ]),
    )
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `pool-${instanceNumId}-${committeeId}.csv`)
  }

  const backLink = (
    <Link
      to="/pools/$committeeId"
      params={{ committeeId: committeeId ?? '' }}
      className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-algo-blue dark:hover:text-algo-teal"
    >
      ← Staking pools
    </Link>
  )

  if (!fracEnabled) {
    return (
      <div>
        {backLink}
        <EmptyPanel>Pooled voting is not available on this network.</EmptyPanel>
      </div>
    )
  }

  if (poolsError) {
    return (
      <div>
        {backLink}
        <EmptyPanel>Pooled voting data is unavailable right now.</EmptyPanel>
      </div>
    )
  }

  if (!loadingPools && !pool) {
    return (
      <div>
        {backLink}
        <EmptyPanel>
          This pool holds no voting power in the selected committee — it never synced the window, or holds nothing in
          it.
        </EmptyPanel>
      </div>
    )
  }

  const share = pool ? pctOf(pool.votes, committee?.totalVotes) : undefined
  const votedPct = poolAq && votedAq !== undefined ? (votedAq / poolAq) * 100 : undefined
  const live = period !== undefined && periodStatus(period.votingStart, period.votingEnd) === 'active'

  const stats: { label: string; value: string; note: string; teal?: boolean }[] = [
    {
      label: 'Voting power',
      value: pool ? pool.votes.toLocaleString() : '—',
      note: ballotNote,
    },
    {
      label: 'Share of committee',
      value: share === undefined ? '—' : `${share.toFixed(1)}%`,
      note: committee ? `of ${committee.totalVotes.toLocaleString()} votes` : 'of the committee',
      teal: true,
    },
    {
      label: 'Members',
      value: pool ? (pool.aq > 0 ? pool.stakers : pool.members).toLocaleString() : '—',
      note: pool && pool.aq > 0 ? 'accounts with stake' : 'accounts',
    },
    {
      label: 'Participation',
      value: votedPct === undefined ? '—' : `${votedPct.toFixed(0)}%`,
      note: periodId === undefined ? 'no period on this window' : `stake voted in Period ${periodId}`,
    },
  ]

  const sidebar = (
    <div className="flex flex-col gap-3.5">
      <SidebarCard title="Your position" accent>
        {myPosition ? (
          <>
            <div className="mt-3.5 flex flex-col gap-2.5">
              <FactRow label="Your stake">
                <span className="tabular-nums">{myPosition.userAq.toLocaleString()} AQ</span>
              </FactRow>
              <FactRow label="Share of pool">
                <span className="tabular-nums">{myPosition.sharePct.toFixed(2)}%</span>
              </FactRow>
              <FactRow label="Share of committee">
                <span className="tabular-nums">
                  {pctOf(myPosition.votes, committee?.totalVotes)?.toFixed(2) ?? '—'}%
                </span>
              </FactRow>
            </div>
            <div className="my-4 h-px bg-border" />
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Your voting power here
            </div>
            <div className="mt-2 font-display text-3xl font-bold leading-none tabular-nums text-teal-strong">
              ≈ {formatApprox(myPosition.votes)}
            </div>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">{ballotNote}</p>
          </>
        ) : (
          <p className="mt-2.5 text-[12.5px] leading-[1.5] text-muted-foreground">
            {activeAddress
              ? 'The connected account holds no stake in this pool for this committee.'
              : 'Connect a wallet to see the stake you hold in this pool.'}
          </p>
        )}
      </SidebarCard>

      <SidebarCard title="Pool facts">
        <div className="mt-3 flex flex-col gap-2.5">
          <FactRow label="Type">{pool ? KIND_LABEL[poolKind(pool.name)] : '—'}</FactRow>
          <FactRow label="Voting Pool App">
            {pool ? <AppExplorerLink appId={pool.appId} prefix="" className="font-mono" /> : '—'}
          </FactRow>
          {/* The protocol itself, as opposed to the frac instance that represents
              it here — resolved from the escrows rather than from the pool's name,
              so it is a fact about what produces the blocks. */}
          <FactRow label={protocolApps.length > 1 ? 'Protocol apps' : 'Protocol app'}>
            {loadingProtocolApps ? (
              // A span, not <Skeleton>: this slot is phrasing content, and a div
              // inside it trips React's hydration nesting check.
              <span className="inline-block h-3.5 w-14 animate-pulse rounded bg-accent align-middle" />
            ) : protocolApps.length === 0 ? (
              '—'
            ) : (
              <span className="inline-flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                {protocolApps.map((appId) => (
                  <AppExplorerLink key={String(appId)} appId={appId} prefix="" className="font-mono" />
                ))}
              </span>
            )}
          </FactRow>
          {/* Registry-wide, unlike the "Members" figure above it: that one counts
              who held stake in this window, this one who is in the pool at all. */}
          <FactRow label="Registered accounts">
            <span className="tabular-nums">{pool ? pool.members.toLocaleString() : '—'}</span>
          </FactRow>
          <FactRow label="Stake in window">
            <span className="tabular-nums">{poolAq ? `${poolAq.toLocaleString()} AQ` : '—'}</span>
          </FactRow>
          <FactRow label="Voting since">{votingSince ?? '—'}</FactRow>
        </div>
      </SidebarCard>

      <SidebarCard title="How this pool votes">
        <div className="mt-3 flex flex-col gap-3">
          {[
            {
              n: '1',
              title: 'Your share is read from chain',
              body: `Your stake in the pool over the ${
                selected ? (selected.periodEnd - selected.periodStart).toLocaleString() : '3,000,000'
              }-block window is read from on-chain state. That share of the pool is your share of its voting power.`,
            },
            {
              n: '2',
              title: terms.isElection ? 'You score the candidates' : 'You score the ballot',
              body: 'Vote from your own account — Support (+1), Veto (−1) or Abstain (0). Nothing is submitted on your behalf.',
            },
            {
              n: '3',
              title: 'The tally updates live',
              body: "The pool's power splits across answers as members vote. Stake that has not voted is counted as Abstain.",
            },
          ].map((step) => (
            <div key={step.n} className="flex items-start gap-2.5">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-algo-blue/10 text-[11px] font-bold text-algo-blue dark:text-algo-teal">
                {step.n}
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold">{step.title}</div>
                <p className="mt-0.5 text-[12px] leading-[1.45] text-muted-foreground">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
        <Link
          to="/docs/pooled-voting"
          className="mt-3.5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-algo-blue hover:opacity-80 dark:text-algo-teal"
        >
          Learn more
          <ArrowRight className="size-3.5" />
        </Link>
      </SidebarCard>
    </div>
  )

  return (
    <SidebarLayout sidebar={sidebar}>
      {backLink}

      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <Eyebrow className="text-algo-blue dark:text-algo-teal">
            {pool ? KIND_LABEL[poolKind(pool.name)] : 'Pooled voting'}
          </Eyebrow>
          <div className="mt-2 flex items-center gap-3">
            {pool && <Avatar name={pool.name} tone={avatarTone(pool.name)} size={36} className="shrink-0" />}
            {loadingPools && !pool ? (
              <Skeleton className="h-9 w-64" />
            ) : (
              <h1 className="min-w-0 font-display text-[26px] font-bold leading-[1.04] sm:text-[32px]">{pool?.name}</h1>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            {pool && <AppExplorerLink appId={pool.appId} className="text-[13px]" />}
            <span aria-hidden>·</span>
            <span>{pool ? plural(pool.aq > 0 ? pool.stakers : pool.members, 'member') : '—'}</span>
            {votingSince && (
              <>
                <span aria-hidden>·</span>
                <span>Voting since {votingSince}</span>
              </>
            )}
          </div>
        </div>
        <PoolCommitteeSelector
          className="sm:shrink-0"
          committees={committees}
          selected={selected}
          periodLabels={periodLabels}
          loading={loadingCommittees}
          variant="period"
          onSelect={(id) =>
            navigate({
              to: '/pools/$committeeId/$instanceNumId',
              params: { committeeId: id, instanceNumId: String(instanceNumId) },
            })
          }
        />
      </div>

      {/* Headline figures. Each fills in on its own: the pool's power and stake
          arrive with the committee read, its share also needs the committee's
          total, and participation needs the period's tally. */}
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4 sm:rounded-none sm:border-x-0 sm:bg-transparent">
        {stats.map((stat, i) => (
          <div
            key={stat.label}
            className={cn(
              'bg-card px-3.5 py-3.5 sm:bg-transparent sm:px-4',
              i < stats.length - 1 && 'sm:border-r sm:border-border',
            )}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {stat.label}
            </div>
            {loadingPools ||
            (stat.label === 'Participation' && loadingCache) ||
            (stat.label === 'Share of committee' && loadingCommittee) ? (
              <Skeleton className="mt-2 h-5 w-16" />
            ) : (
              <div className={cn('mt-1.5 text-[18px] font-semibold tabular-nums', stat.teal && 'text-teal-strong')}>
                {stat.value}
              </div>
            )}
            <div className="mt-1 text-[10.5px] text-muted-foreground">{stat.note}</div>
          </div>
        ))}
      </div>

      {/* ── Voting record ── */}
      <div className="mt-7 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h2 className="font-display text-[19px] font-bold sm:text-xl">Voting record</h2>
        {periodId !== undefined && (
          <span className="text-[12.5px] text-muted-foreground">
            <Link
              to="/vote/period/$periodId/results"
              params={{ periodId: String(periodId) }}
              className="font-semibold text-algo-blue hover:underline dark:text-algo-teal"
            >
              {periodLabel}
            </Link>{' '}
            · {plural(items.length, terms.item)}
          </span>
        )}
      </div>

      {/* A committee can back several periods; when it does, the ballot is a
          choice and lives in the URL so it can be linked. */}
      {started.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {started.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                navigate({
                  to: '/pools/$committeeId/$instanceNumId',
                  params: { committeeId: committeeId ?? '', instanceNumId: String(instanceNumId) },
                  search: { period: id },
                })
              }
              className={cn(
                'rounded-md border px-2.5 py-1 text-[12px] font-semibold transition-colors',
                id === periodId
                  ? 'border-algo-blue bg-algo-blue/10 text-algo-blue dark:border-algo-teal dark:text-algo-teal'
                  : 'border-input text-muted-foreground hover:border-ring',
              )}
            >
              Period {id}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
        <div
          className={cn(
            RECORD_GRID,
            'hidden border-b border-border bg-muted/40 px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground sm:grid',
          )}
        >
          <span>Topic or candidate</span>
          <span className="text-right">Support</span>
          <span className="text-right">Veto</span>
          <span className="text-right">Abstain</span>
        </div>
        {periodId === undefined ? (
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
            No period has opened on this committee yet, so the pool has nothing to have voted on.
          </p>
        ) : loadingCache ? (
          <div className="flex flex-col gap-2 p-3.5">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : cacheError ? (
          // Ahead of the empty-ballot branch on purpose: a failed read also leaves
          // `cache` undefined and `items` empty, and "no items on this ballot" is a
          // claim about the ballot rather than about the read.
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
            This pool&rsquo;s voting record is unavailable right now.
          </p>
        ) : cache === null ? (
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
            This pool has not synced {periodLabel}, so it could not have voted on it.
          </p>
        ) : items.length === 0 ? (
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
            {poolAq === undefined
              ? 'This pool has no AlgoQuarters ledger for the window, so there is no stake to split across the ballot.'
              : `No ${terms.items} on this ballot.`}
          </p>
        ) : (
          <>
            {shownItems.map((item) => (
              <RecordRow key={item.topicIndex} item={item} periodId={periodId} live={live} />
            ))}
            {items.length > RECORD_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllItems((v) => !v)}
                className="block w-full px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-algo-blue transition-colors hover:bg-muted/40 dark:text-algo-teal"
              >
                {showAllItems ? 'Show fewer' : `Show all ${items.length} items`}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Members ── */}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <h2 className="font-display text-[19px] font-bold sm:text-xl">Members</h2>
        <div className="flex w-full items-center justify-between gap-3.5 sm:w-auto">
          <span className="text-[12.5px] text-muted-foreground">
            {loadingMembers
              ? 'Loading…'
              : `${members.length.toLocaleString()} with stake · ${poolAq ? `${poolAq.toLocaleString()} AQ` : 'no ledger'}`}
          </span>
          <button
            type="button"
            onClick={handleExport}
            disabled={members.length === 0}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[12.5px] font-semibold transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
        <div
          className={cn(
            MEMBER_GRID,
            'border-b border-border bg-muted/40 px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground sm:px-4',
          )}
        >
          <span>#</span>
          <span>Account</span>
          <span className="hidden text-right sm:block">Stake</span>
          <span className="hidden text-right sm:block">Share</span>
          <span className="hidden text-right sm:block">{periodLabel ?? 'Vote'}</span>
          <span />
        </div>

        {membersError ? (
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">The member list is unavailable right now.</p>
        ) : loadingMembers ? (
          <div className="flex flex-col gap-2 p-3.5">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : members.length === 0 ? (
          <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
            No account holds AlgoQuarters in this pool for the window — its ledger has not been ingested yet.
          </p>
        ) : (
          <>
            {rows.map((member) => (
              <MemberRow
                key={member.address}
                member={member}
                items={shownItems}
                periodLabel={periodLabel}
                ballotNote={ballotNote}
                expanded={openMember === member.address}
                onToggle={() => setOpenMember((open) => (open === member.address ? null : member.address))}
                recordsLoading={loadingRecords}
                recordsError={recordsError}
              />
            ))}
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 bg-muted/40 px-3.5 py-3 sm:px-4">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-55"
                >
                  ← Previous
                </button>
                <span className="text-[13px] text-muted-foreground">
                  Page <strong className="tabular-nums text-foreground">{page + 1}</strong> of{' '}
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

      <p className="mt-3 text-xs leading-[1.5] text-muted-foreground">
        Stake is measured in AlgoQuarters. 1 AQ = 1 ALGO held in the pool for the full{' '}
        {selected ? (selected.periodEnd - selected.periodStart).toLocaleString() : '3,000,000'}-block window.{' '}
      </p>
    </SidebarLayout>
  )
}
