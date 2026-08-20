import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronDown, Clock, Download } from 'lucide-react'
import type { AccountWithVotes, GGovReaderSDK } from 'ggov-sdk'
import {
  useCommittee,
  useCommitteeMembers,
  useBlockHeaders,
  type CommitteeOption,
  type BlockHeaderInfo,
} from '@/hooks/queries'
import { formatMonthDayYear, formatTime, roundsToDays } from '@/utils/time'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { Skeleton } from '@/components/ui/skeleton'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Surface } from '@/components/ui/surface'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAddressName } from '@/hooks/use-nfd'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { AccountAvatar } from '@/components/AccountAvatar'
import BackButton from '@/components/BackButton'
import PooledVotingCard from '@/components/PooledVotingCard'
import { csvDocument, downloadBlob } from '@/utils/download'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 25

/** Shorten a base64url committee id for the title (first 8 … last 6). */
function ellipseCommitteeId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

// ── Export dropdown ─────────────────────────────────────────────────────────

type ExportKind = 'csv' | 'json'

/** Build and download the full committee as CSV or the canonical ARC-86 JSON. */
async function downloadCommittee(
  kind: ExportKind,
  committee: CommitteeOption,
  members: AccountWithVotes[],
  readerSDK: GGovReaderSDK,
) {
  let blob: Blob
  let filename: string
  if (kind === 'csv') {
    const total = committee.totalVotes
    const sharePct = (votes: number) => (total > 0 ? (votes / total) * 100 : 0)
    // Members are stored ranked by votes; mirror that ordering in the export.
    const ranked = [...members].sort((a, b) => b.votes - a.votes)
    const csv = csvDocument(
      ['rank', 'account', 'votes', 'share_pct'],
      ranked.map((m, i) => [i + 1, m.account.toString(), m.votes, sharePct(m.votes).toFixed(4)]),
    )
    blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    filename = `${committee.periodStart}-${committee.periodEnd}-${committee.idBase64Url}.csv`
  } else {
    // Read the committee straight from chain and serialise it as the canonical
    // ARC-86 committee file: minified, fields in canonical order, govs sorted by
    // address. This is byte-identical to the published committee files, so the
    // file's hash reproduces the committee id.
    const file = await readerSDK.registry.fastGetCommittee(committee.id)
    if (!file) throw new Error('Committee not found on chain')
    blob = new Blob([JSON.stringify(file)], { type: 'application/json' })
    filename = `${file.periodStart}-${file.periodEnd}-${committee.idBase64Url}.json`
  }

  downloadBlob(blob, filename)
}

function ExportMenu({ onExport, disabled }: { onExport: (kind: ExportKind) => void; disabled: boolean }) {
  // Radix DropdownMenu owns open/close, focus management, keyboard navigation
  // (arrows, Home/End, typeahead), Escape, click-outside and ARIA roles.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="group inline-flex shrink-0 items-center gap-2 rounded-md border border-input bg-background px-3.5 py-2 font-display text-sm font-bold transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Download className="size-[15px]" />
        Export
        <ChevronDown className="size-3.5 transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onExport('csv')} className="gap-2.5 px-3 py-2.5">
          <span className="rounded bg-algo-blue/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-algo-blue dark:text-algo-teal">
            CSV
          </span>
          <span className="flex-1">Comma-separated</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onExport('json')} className="gap-2.5 px-3 py-2.5">
          <span className="rounded bg-success/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-success-strong dark:text-success">
            JSON
          </span>
          <span className="flex-1">Structured JSON</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Start / End block panel ──────────────────────────────────────────────────

/** A labelled row in a boundary block's mini-list. Mono value, "—" when absent. */
function BlockField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[12.5px]">{children}</span>
    </div>
  )
}

function Muted() {
  return <span className="text-muted-foreground">—</span>
}

function BoundaryBlock({
  kind,
  round,
  header,
  loading,
}: {
  kind: 'start' | 'end'
  round: number
  header: BlockHeaderInfo | null | undefined
  loading: boolean
}) {
  const dotClass = kind === 'start' ? 'bg-success' : 'bg-algo-orange'
  const label = kind === 'start' ? 'Start block' : 'End block'
  return (
    <div className="p-5">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full', dotClass)} />
        <Eyebrow>{label}</Eyebrow>
      </div>
      <div className="mt-2.5 font-display text-[26px] font-bold leading-none tabular-nums">
        {round.toLocaleString()}
      </div>
      <div className="mt-3.5 flex flex-col gap-1.5">
        <BlockField label="Date">
          {loading ? (
            <Skeleton className="ml-auto h-3.5 w-20" />
          ) : header ? (
            formatMonthDayYear(header.timestamp)
          ) : (
            <Muted />
          )}
        </BlockField>
        <BlockField label="Time">
          {loading ? (
            <Skeleton className="ml-auto h-3.5 w-24" />
          ) : header ? (
            <span className="font-mono">{formatTime(header.timestamp)}</span>
          ) : (
            <Muted />
          )}
        </BlockField>
      </div>
    </div>
  )
}

function StartEndPanel({ committee }: { committee: CommitteeOption }) {
  const rounds = committee.periodEnd - committee.periodStart
  const days = roundsToDays(rounds)
  const headers = useBlockHeaders([committee.periodStart, committee.periodEnd])
  const startHeader = headers[committee.periodStart]
  const endHeader = headers[committee.periodEnd]

  return (
    <Surface className="mt-5 grid grid-cols-1 overflow-hidden sm:grid-cols-[1fr_auto_1fr]">
      <BoundaryBlock
        kind="start"
        round={committee.periodStart}
        header={startHeader}
        loading={startHeader === undefined}
      />
      <div className="relative flex flex-row items-center justify-center gap-3 border-y border-border bg-muted/40 px-5 py-3 sm:flex-col sm:gap-1 sm:border-x sm:border-y-0">
        <Clock className="absolute left-5 size-5 text-muted-foreground sm:static sm:left-auto" />
        <div className="text-center">
          <div className="font-display text-[15px] font-bold whitespace-nowrap">
            {days > 0 ? `${days.toLocaleString()} days` : '—'}
          </div>
          <div className="text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
            {rounds.toLocaleString()} rounds
          </div>
        </div>
      </div>
      <BoundaryBlock kind="end" round={committee.periodEnd} header={endHeader} loading={endHeader === undefined} />
    </Surface>
  )
}

// ── Members leaderboard ──────────────────────────────────────────────────────

/**
 * Four columns on tablet and up. Narrower than that the share column's 120px
 * minimum left the account column ~46px — enough for the avatar and nothing
 * else — so below `sm` the row drops to rank / account / votes and the share
 * bar moves inline under the account name (matching the design's mobile frame).
 */
const LEADERBOARD_GRID =
  'grid grid-cols-[28px_1fr_auto] items-center gap-3 sm:grid-cols-[36px_1fr_minmax(120px,200px)_90px] sm:gap-3.5'

/** Share-of-total meter. Same track/fill at both breakpoints, different height. */
function ShareBar({ barPct, className }: { barPct: number; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-algo-blue dark:bg-algo-teal" style={{ width: `${barPct}%` }} />
    </div>
  )
}

function MemberRow({
  address,
  rank,
  votes,
  share,
  barPct,
}: {
  address: string
  rank: number
  votes: number
  share: number
  barPct: number
}) {
  const { data: name } = useAddressName(address)
  const ellipsed = ellipseAddress(address, 6)
  return (
    <Link
      to="/account/$address"
      params={{ address }}
      className={cn(
        LEADERBOARD_GRID,
        'border-b border-border px-3.5 py-3 transition-colors last:border-0 hover:bg-muted/40 sm:px-4.5',
      )}
    >
      <span
        className={cn(
          'font-display text-[15px] font-bold tabular-nums',
          rank <= 3 ? 'text-algo-blue dark:text-algo-teal' : 'text-muted-foreground',
        )}
      >
        {rank}
      </span>
      <div className="flex min-w-0 items-center gap-2.5">
        <AccountAvatar address={address} name={name} size={28} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-algo-blue dark:text-algo-teal">
            {name ?? ellipsed}
          </div>
          {name && <div className="truncate font-mono text-[11.5px] text-muted-foreground">{ellipsed}</div>}
          {/* Below `sm` the share column is gone, so the bar rides under the name. */}
          <ShareBar barPct={barPct} className="mt-1.5 h-[5px] sm:hidden" />
        </div>
      </div>
      <div className="hidden items-center gap-2.5 sm:flex">
        <ShareBar barPct={barPct} className="h-[7px] flex-1" />
        <span className="w-[46px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {share.toFixed(2)}%
        </span>
      </div>
      <span className="text-right text-[13px] font-semibold tabular-nums sm:text-sm">{votes.toLocaleString()}</span>
    </Link>
  )
}

export default function CommitteeDetail() {
  const { committeeId } = useParams({ strict: false })
  // Summary resolves from its own committee query (warm if the list loaded first).
  const { data: committee, isLoading: loadingCommittee } = useCommittee(committeeId)
  // Members resolve independently, so the table renders even when the committee
  // lookup fails (the not-found state still loads the table).
  const { data: members = [], isLoading: loadingMembers } = useCommitteeMembers(committeeId)
  const { readerSDK } = useGGovSDK()
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)

  async function handleExport(kind: ExportKind) {
    if (!committee || exporting) return
    setExporting(true)
    try {
      await downloadCommittee(kind, committee, members, readerSDK)
    } catch (err) {
      console.error('Committee export failed', err)
    } finally {
      setExporting(false)
    }
  }

  // Stable ranking by votes (highest first); the share bar scales to the leader.
  const { ranked, maxVotes, total } = useMemo(() => {
    const ranked = [...members].sort((a, b) => b.votes - a.votes)
    return {
      ranked,
      maxVotes: ranked[0]?.votes ?? 0,
      total: committee?.totalVotes ?? ranked.reduce((sum, m) => sum + m.votes, 0),
    }
  }, [members, committee?.totalVotes])

  const totalPages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE))
  const start = page * PAGE_SIZE
  const paginated = ranked.slice(start, start + PAGE_SIZE)
  const hasMembers = ranked.length > 0

  // Restart at the first page when switching committees — this route component
  // stays mounted across :committeeId changes, so the page would otherwise carry over.
  useEffect(() => {
    setPage(0)
  }, [committeeId])

  // Clamp if the ranked list shrinks (e.g. a background refetch) so we never
  // render an out-of-range, empty page.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1))
  }, [totalPages])

  return (
    <div className="mx-auto max-w-[880px]">
      <div className="flex items-center gap-3">
        <BackButton to="/committees" />
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2.5 font-display text-[30px] font-bold leading-none">
          Committee
          {committeeId && (
            <span className="truncate font-mono font-medium text-muted-foreground">
              {ellipseCommitteeId(committeeId)}
            </span>
          )}
        </h1>
        {committee && <ExportMenu disabled={!hasMembers || exporting} onExport={handleExport} />}
      </div>

      {committee && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground">
          <span>
            <strong className="text-foreground tabular-nums">{committee.totalMembers.toLocaleString()}</strong> members
          </span>
          <span aria-hidden>·</span>
          <span>
            <strong className="text-foreground tabular-nums">{committee.totalVotes.toLocaleString()}</strong> total
            votes
          </span>
        </div>
      )}

      {/* Summary + block panel (omitted when the committee isn't found). */}
      {loadingCommittee ? (
        <Skeleton className="mt-5 h-44 w-full" />
      ) : committee ? (
        <StartEndPanel committee={committee} />
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center">
          <div className="font-display text-base font-bold">Committee not found</div>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            No committee matches this id. The member table below still loads independently.
          </p>
        </div>
      )}

      {/* Pooled voting. Part of the summary, so it follows the block panel in
          being omitted when the committee isn't found — but it fetches its own
          pool data and fills in independently of everything above it. */}
      {(loadingCommittee || committee) && (
        <PooledVotingCard
          className="mt-5"
          committeeId={committeeId}
          totalVotes={committee?.totalVotes}
          loadingTotalVotes={loadingCommittee}
        />
      )}

      {/* Members leaderboard. */}
      <div className="mt-7 flex items-baseline justify-between gap-3">
        <Eyebrow>Members</Eyebrow>
        <span className="text-xs text-muted-foreground">Ranked by votes (blocks produced)</span>
      </div>

      <Surface className="mt-3.5 overflow-hidden">
        <div
          className={cn(
            LEADERBOARD_GRID,
            'border-b border-input px-3.5 py-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground sm:px-4.5',
          )}
        >
          <span>#</span>
          <span>Account</span>
          {/* Hidden below `sm`, where the row has no share column of its own. */}
          <span className="hidden sm:block">Share of total</span>
          <span className="text-right">Votes</span>
        </div>

        {loadingMembers ? (
          <div className="flex flex-col gap-2 p-3.5 sm:p-4.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !hasMembers ? (
          <div className="flex items-center justify-center px-4.5 py-10 text-[13.5px] text-muted-foreground">
            No members found.
          </div>
        ) : (
          <>
            {paginated.map((m, i) => {
              const rank = start + i + 1
              const votes = m.votes
              return (
                <MemberRow
                  key={m.account.toString()}
                  address={m.account.toString()}
                  rank={rank}
                  votes={votes}
                  share={total > 0 ? (votes / total) * 100 : 0}
                  barPct={maxVotes > 0 ? Math.round((votes / maxVotes) * 100) : 0}
                />
              )
            })}

            {/* Pager + caption on an inset footer. */}
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
          </>
        )}
      </Surface>

      {hasMembers && (
        <p className="mt-2.5 text-xs text-muted-foreground">
          Showing{' '}
          <span className="tabular-nums">
            {start + 1}–{Math.min(start + PAGE_SIZE, ranked.length)}
          </span>{' '}
          of <span className="tabular-nums">{ranked.length.toLocaleString()}</span> members. Export includes the full
          committee.
        </p>
      )}
    </div>
  )
}
