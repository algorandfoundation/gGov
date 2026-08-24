import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { fromBase64Url, queryKeys } from '@/hooks/queries'
import type {
  FracAccountCommitteeAq,
  FracAccountVotingRecord,
  FracInstanceCommittee,
  FracPeriodVoteCache,
  FracRegAccount,
  FracVotingRecord,
} from 'frac-delegation-sdk'

/**
 * Pooled voting power — an account's share of the gGov power held by the staking
 * pools it belongs to (xALGO, tALGO, Réti). Kept in its own module rather than
 * `queries.ts` so a network with no frac registry never pulls in the frac SDK.
 *
 * The model (see `FRAC_ARCHITECTURE.md`): each pool is a frac *instance* whose
 * *escrow* accounts hold real gGov voting power. That power is split among the
 * pool's members pro-rata by **AlgoQuarters** (AQ — 1 ALGO staked for a full
 * 3M-block window), computed off-chain and ingested per committee. So a member's
 * weight in a committee is `userAq / totalAq x <the pool's gGov power>`.
 *
 * These figures are approximate on purpose. On-chain the split is
 * `floor(tally * totalVotes / totalAq)` with the last option absorbing the
 * remainder, so a member's realised weight depends on how the whole pool votes.
 * Callers render pooled values behind a "≈"; direct (block-production) power is
 * an exact integer and never gets one.
 */

/** The pooled slice of the SDK context — what every query in this module reads through. */
type FracSDKContext = ReturnType<typeof useGGovSDK>

/** One pool position: this account's share of one instance's power in one committee. */
export interface PooledPosition {
  instanceNumId: number
  /** Human-readable pool label, as reported by the instance. */
  instanceName: string
  /** This account's AlgoQuarters in the committee. */
  userAq: number
  /** Every member's AlgoQuarters in the committee — the split denominator. */
  totalAq: number
  /** `userAq / totalAq * 100`. */
  sharePct: number
  /** The pool's own gGov voting power for this committee (sum over its escrows). */
  poolVotes: number
  /** `sharePct / 100 * poolVotes` — approximate, see the module docblock. */
  votes: number
}

export interface PooledPositions {
  /** Committee id (base64url) → this account's positions, strongest first. */
  byCommittee: Record<string, PooledPosition[]>
  /**
   * Whether this account belongs to at least one pool. Resolves from a single
   * read, well before any amounts do, so UI can commit to the pooled layout
   * up front instead of shifting from direct-only once numbers arrive.
   */
  isPoolMember: boolean
  isLoading: boolean
  /** False on networks with no frac registry — no pooled query is issued at all. */
  fracEnabled: boolean
}

const EMPTY_POSITIONS: Record<string, PooledPosition[]> = {}

/**
 * The account's frac registry record: its numeric account ID and the instances
 * it belongs to. One read, and the short-circuit for everything below — an
 * account in no pool leaves every downstream query disabled.
 */
export function useFracAccount(account: string | null | undefined) {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.fracAccount(account ?? ''),
    queryFn: async (): Promise<FracRegAccount | null> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return null
      const map = await sdk.registry.getFracRegAccountsMap([account!])
      const record = map.get(account!)
      // Unregistered accounts come back as accountId 0 with no instances.
      return record && record.accountId > 0 ? record : null
    },
    enabled: fracEnabled && !!account,
    staleTime: 60_000,
  })
}

/**
 * Per instance, its synced snapshot of each committee — keyed by committee id.
 * `FracInstanceCommittee.totalVotes` is the pool's gGov power for that
 * committee, and a committee absent from the map is one the pool has never
 * `syncCommittee`'d (so it cannot carry a pooled share at all).
 *
 * TODO(perf): this fans out one read per instance, because `logCommittees` batches
 * committee ids but is instance-scoped — there is no cross-instance equivalent.
 * The registry already has the right shape for one (`logAccountInstanceAq` pages
 * across an account's instances); `logInstanceCommittees` is the same idea for
 * the committee-scoped transpose, but it takes one committee, so it does not
 * cover this hook's many-committees case.
 * Better still, fold `totalVotes` into `FracAccountCommitteeAq` and extend
 * `logAccountInstanceAq` to take several committees (see the TODO on
 * `usePooledCommitteeAqs`) — that collapses this whole module to a single read
 * and removes this hook entirely. Both need contract work, so they are follow-ups.
 */
export function useFracInstanceCommittees(
  instanceNumIds: number[],
  committeeIdsBase64Url: string[],
): { byInstance: Record<number, Record<string, FracInstanceCommittee>>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const enabled = fracEnabled && committeeIdsBase64Url.length > 0

  const results = useQueries({
    queries: instanceNumIds.map((instanceNumId) => ({
      queryKey: queryKeys.fracInstanceCommittees(instanceNumId, committeeIdsBase64Url),
      queryFn: async (): Promise<Record<string, FracInstanceCommittee>> => {
        const sdk = await getFracReaderSDK()
        if (!sdk) return {}
        // Index-aligned with the ids we passed; batched 63/call by the SDK.
        const snapshots = await sdk.getCommittees(instanceNumId, committeeIdsBase64Url.map(fromBase64Url))
        const out: Record<string, FracInstanceCommittee> = {}
        committeeIdsBase64Url.forEach((id, i) => {
          const snapshot = snapshots[i]
          // Unsynced, or synced but the pool holds no power there — either way
          // there is no share to show.
          if (snapshot && snapshot.totalVotes > 0) out[id] = snapshot
        })
        return out
      },
      enabled,
      staleTime: 300_000,
    })),
  })

  const byInstance: Record<number, Record<string, FracInstanceCommittee>> = {}
  instanceNumIds.forEach((instanceNumId, i) => {
    const data = results[i]?.data
    if (data) byInstance[instanceNumId] = data
  })
  return { byInstance, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

/**
 * Per committee, this account's AlgoQuarters standing across every instance it
 * belongs to — one entry per pool, carrying the pool's name and the account's
 * `userAq` against the committee's `totalAq`.
 *
 * TODO(perf): this fans out one read per committee, because
 * `getAccountInstanceAQs` / `logAccountInstanceAq`
 * (`contracts/smart_contracts/frac-delegation/fracDelegationRegistry.algo.ts`)
 * is cross-instance but takes a *single* `committeeId`. Wanted:
 * `logAccountCommitteeAqs(account, committeeIds[], limit, offset)`. Sizing note
 * for whoever writes it — these are loggers rather than plain getters because of
 * the 1024-byte ABI-return limit, and a simulate group carries at most 128
 * unnamed refs, so existing batch readers chunk 63/call and 126/group; each AQ
 * page also inner-calls its instances, which is what bounds `aqPageSize` today.
 */
export function usePooledCommitteeAqs(
  account: string | null | undefined,
  committeeIdsBase64Url: string[],
): { byCommittee: Record<string, FracAccountCommitteeAq[]>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const results = useQueries({
    queries: committeeIdsBase64Url.map((idBase64Url) => ({
      queryKey: queryKeys.fracAccountCommitteeAq(account ?? '', idBase64Url),
      queryFn: async (): Promise<FracAccountCommitteeAq[]> => {
        const sdk = await getFracReaderSDK()
        if (!sdk) return []
        const entries = await sdk.registry.getAccountInstanceAQs(account!, fromBase64Url(idBase64Url))
        // An instance that has not synced this committee reports zeros; a member
        // with no stake in the window reports userAq 0. Neither is a position.
        return entries.filter((e) => e.userAq > 0 && e.totalAq > 0)
      },
      enabled: fracEnabled && !!account,
      staleTime: 60_000,
    })),
  })

  const byCommittee: Record<string, FracAccountCommitteeAq[]> = {}
  committeeIdsBase64Url.forEach((idBase64Url, i) => {
    const data = results[i]?.data
    if (data?.length) byCommittee[idBase64Url] = data
  })
  return { byCommittee, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

/**
 * The one pooled hook the pages use. Pooled only — direct block-production power
 * stays on its existing hooks (`useCommitteeVotingPowers`, `useGovVotingPowers`),
 * so wiring pooled power in cannot regress the direct figures.
 *
 * Pass the committees you intend to display: the whole list for the account page,
 * just the featured period's committee for the landing hero. AQ reads are then
 * restricted to those committees a pool has actually synced, which is exact
 * rather than a guess — an unsynced committee provably has no share to report.
 *
 * Note `sharePct` moves while a pool's AQ ledger is still being ingested, since
 * `totalAq` grows until the ingest completes.
 */
export function usePooledPositions(
  account: string | null | undefined,
  committeeIdsBase64Url: string[],
): PooledPositions {
  const { fracEnabled } = useGGovSDK()

  const { data: fracAccount, isPending: accountPending, fetchStatus } = useFracAccount(account)
  const instanceNumIds = fracAccount?.instanceNumIds ?? []
  const isPoolMember = instanceNumIds.length > 0

  const { byInstance, isLoading: committeesLoading } = useFracInstanceCommittees(instanceNumIds, committeeIdsBase64Url)

  // Only committees some pool has synced can carry a share, so this is the exact
  // set worth an AQ read — not a heuristic cap.
  const syncedIds = committeeIdsBase64Url.filter((id) =>
    instanceNumIds.some((instanceNumId) => byInstance[instanceNumId]?.[id] !== undefined),
  )
  const { byCommittee: aqByCommittee, isLoading: aqLoading } = usePooledCommitteeAqs(account, syncedIds)

  const byCommittee: Record<string, PooledPosition[]> = {}
  for (const [idBase64Url, entries] of Object.entries(aqByCommittee)) {
    const positions: PooledPosition[] = []
    for (const entry of entries) {
      const poolVotes = byInstance[entry.instanceNumId]?.[idBase64Url]?.totalVotes
      if (!poolVotes) continue
      const sharePct = (entry.userAq / entry.totalAq) * 100
      positions.push({
        instanceNumId: entry.instanceNumId,
        instanceName: entry.instanceName,
        userAq: entry.userAq,
        totalAq: entry.totalAq,
        sharePct,
        poolVotes,
        votes: (sharePct / 100) * poolVotes,
      })
    }
    if (positions.length) {
      positions.sort((a, b) => b.votes - a.votes)
      byCommittee[idBase64Url] = positions
    }
  }

  return {
    byCommittee: Object.keys(byCommittee).length ? byCommittee : EMPTY_POSITIONS,
    isPoolMember,
    isLoading: (accountPending && fetchStatus !== 'idle') || (isPoolMember && (committeesLoading || aqLoading)),
    fracEnabled,
  }
}

// ─── Committee composition (the committees page) ─────────────────────────────
//
// The hooks above are account-scoped: what one member holds. This one is the
// aggregate — how much of a committee's power sits in pools at all, and in which.
// No account is involved, so it reads with no wallet connected.

/** One pool's stake in a committee. */
export interface CommitteePool {
  instanceNumId: number
  /** The instance contract's on-chain app id — the pool's identity off this page. */
  appId: bigint
  /** The committee's *numeric* id as this instance knows it — instance-local. */
  committeeNumId: number
  /** Pool label as the registry reports it, e.g. "Folks Finance xALGO". */
  name: string
  /** Accounts registered to the pool. Registry-wide — see {@link CommitteePools}. */
  members: number
  /**
   * Accounts holding AlgoQuarters in *this* committee — window-scoped, unlike
   * {@link members}. 0 when the pool has no ledger open (so is `aq`).
   */
  stakers: number
  /** The pool's gGov power in this committee: the sum of its escrows' votes. */
  votes: number
  /**
   * The AlgoQuarters behind that power — the denominator a member's share is split
   * against. Voting power says how much weight the pool carries; this says how much
   * ALGO-time its members put in to earn it. 0 when ingestion has not started.
   */
  aq: number
}

/** Every pool holding gGov power in one committee. */
export interface CommitteePools {
  /** Pools with power here, strongest first. Pools that never synced are absent. */
  pools: CommitteePool[]
  /** Their combined gGov power — exact, unlike a member's split of it. */
  pooledVotes: number
  /**
   * Σ `members` over those pools. Registry-wide per pool, not window-scoped: a
   * pool's roster is a live figure, so this counts who is in the pools that held
   * power here, not who held stake during the window.
   */
  participants: number
  isLoading: boolean
  /** The registry read failed — callers say so rather than rendering zeros. */
  isError: boolean
  /** False on networks with no frac registry — no pooled query is issued at all. */
  fracEnabled: boolean
}

type CommitteePoolTotals = Pick<CommitteePools, 'pools' | 'pooledVotes' | 'participants'>

const EMPTY_TOTALS: CommitteePoolTotals = { pools: [], pooledVotes: 0, participants: 0 }

/**
 * Which pools hold a committee's voting power, and how much.
 *
 * Each pool is a frac *instance* whose escrows produce blocks; the instance's
 * synced snapshot of a committee carries `totalVotes` — that pool's gGov power
 * for the window, already summed over its escrows. So unlike a member's share
 * (`floor`-split, hence the "≈" convention in this module's docblock), these are
 * exact integers and are rendered without one.
 *
 * A committee absent from an instance's snapshot map, or present with zero
 * votes, has no pooled stake from that pool — that is a provable absence, not a
 * gap in the data.
 *
 * One paged read, whatever the pool count: the registry's `logInstanceCommittees`
 * enumerates its own instances and inner-calls each one's `getCommitteeStanding`,
 * so a page carries identity, voting power and AlgoQuarters together. It also
 * drops instances whose app has been deleted on chain, which is what retires the
 * `getExistingInstances()` pre-read this used to open with — that cost an algod
 * lookup per instance on top of a snapshot read per instance.
 */
export function useCommitteePools(committeeIdBase64Url: string | undefined): CommitteePools {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { data, isPending, fetchStatus, isError } = useQuery({
    queryKey: queryKeys.fracCommitteePools(committeeIdBase64Url ?? ''),
    queryFn: async (): Promise<CommitteePoolTotals> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return EMPTY_TOTALS
      const standings = await sdk.registry.getInstanceCommitteeStandings(fromBase64Url(committeeIdBase64Url!))
      const pools = standings
        // A standing with no votes is an instance that never synced this committee,
        // or synced it and holds nothing — either way it has no pooled stake here.
        .filter((standing) => standing.totalVotes > 0)
        .map(
          (standing): CommitteePool => ({
            instanceNumId: standing.instanceNumId,
            appId: standing.instanceAppId,
            committeeNumId: standing.committeeNumId,
            name: standing.instanceName,
            members: Number(standing.instanceNumAccounts),
            stakers: standing.numAccounts,
            votes: standing.totalVotes,
            aq: standing.totalAq,
          }),
        )
      pools.sort((a, b) => b.votes - a.votes)
      return {
        pools,
        pooledVotes: pools.reduce((sum, pool) => sum + pool.votes, 0),
        participants: pools.reduce((sum, pool) => sum + pool.members, 0),
      }
    },
    enabled: fracEnabled && !!committeeIdBase64Url,
    // A committee is a closed historical window; its snapshots only change while
    // a pool is still syncing it.
    staleTime: 300_000,
  })
  return {
    ...(data ?? EMPTY_TOTALS),
    // A disabled query sits at `isPending` forever, which would leave the section
    // in a skeleton on a network with no frac registry — same guard the hooks above use.
    isLoading: isPending && fetchStatus !== 'idle',
    isError,
    fracEnabled,
  }
}

// ─── Pool turnout (the pools index) ──────────────────────────────────────────
//
// `useCommitteePools` answers "which pools, how much power, and how much stake
// behind it" in one read. Turnout is the one figure it cannot carry: it is
// period-scoped, and a committee can back several periods.

/**
 * The AlgoQuarters behind a pool's internal tally on one topic. gGov makes every
 * voter spend their full weight on every topic (enforced on-chain in `vote()`),
 * so any topic's option-sum is the same figure; take the max across topics for
 * the same robustness reason `lib/turnout.ts` does.
 */
export function votedAqOf(internal: number[][]): number {
  return internal.reduce(
    (max, topic) =>
      Math.max(
        max,
        topic.reduce((a, b) => a + b, 0),
      ),
    0,
  )
}

/**
 * One pool's own vote tallies for one period — `internal` is [topic][option] in
 * AlgoQuarters, exactly as its members cast them, and `ggovTotals` the gGov votes
 * those AlgoQuarters were translated into.
 *
 * Null when the pool never synced the period: it *cannot* have voted, which is a
 * different statement from "voted nothing", and both callers say so.
 *
 * The whole struct is cached rather than a figure derived from it, because the
 * two surfaces want different parts of the same box — the pools index only needs
 * the AlgoQuarters that voted ({@link useCommitteePoolVotedAq}), the pool page
 * needs the per-item split — and neither should cost a second read.
 */
function poolVoteCacheQuery(
  getFracReaderSDK: FracSDKContext['getFracReaderSDK'],
  instanceNumId: number,
  periodId: number | undefined,
  fracEnabled: boolean,
) {
  return {
    queryKey: queryKeys.fracPeriodVoteCache(instanceNumId, periodId ?? 0),
    queryFn: async (): Promise<FracPeriodVoteCache | null> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return null
      return (await sdk.getPeriodVoteCache(instanceNumId, periodId!)) ?? null
    },
    enabled: fracEnabled && periodId !== undefined,
    // Live while the period is open, so much shorter than the committee reads.
    staleTime: 30_000,
  }
}

/**
 * How much of each pool's stake has cast an internal ballot on one period.
 *
 * Returned raw rather than as a percentage: the denominator is the pool's `aq`
 * from {@link useCommitteePools}, which resolves independently.
 *
 * A pool that never synced the period is absent — it *cannot* have voted, which
 * is a different statement from "voted nothing", and the index says so.
 */
export function useCommitteePoolVotedAq(
  pools: CommitteePool[],
  periodId: number | undefined,
): { byInstance: Record<number, number>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const results = useQueries({
    queries: pools.map((pool) => poolVoteCacheQuery(getFracReaderSDK, pool.instanceNumId, periodId, fracEnabled)),
  })

  const byInstance: Record<number, number> = {}
  pools.forEach((pool, i) => {
    const data = results[i]?.data
    if (data) byInstance[pool.instanceNumId] = votedAqOf(data.internal)
  })
  return { byInstance, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

/**
 * One pool's tally for one period, for the pool page. Shares its cache entry with
 * the pools index's turnout column, so arriving from the index costs no read.
 *
 * `isError` is exposed because `cache` alone cannot carry the difference: a failed
 * read leaves it `undefined`, which the caller would otherwise render as an empty
 * ballot rather than as a read it could not make. `null` is the real "not synced".
 */
export function usePoolVoteCache(
  instanceNumId: number | undefined,
  periodId: number | undefined,
): { cache: FracPeriodVoteCache | null | undefined; isLoading: boolean; isError: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const query = poolVoteCacheQuery(getFracReaderSDK, instanceNumId ?? 0, periodId, fracEnabled)
  const { data, isPending, fetchStatus, isError } = useQuery({ ...query, enabled: query.enabled && !!instanceNumId })
  return { cache: data, isLoading: isPending && fetchStatus !== 'idle', isError }
}

// ─── Pooled ballot (the voting page) ──────────────────────────────────────────
//
// The account page needs one account across many committees; the ballot needs the
// reverse — many accounts (the wallet's own, plus every account that delegated to
// it) against the *one* committee the period runs on, and each position's
// eligibility to actually cast. The hooks below are that transpose. Where the
// shape matches they reuse the account page's query keys, so the two surfaces
// share cache rather than re-reading the same boxes.

/**
 * Several accounts' frac registry records in a single read — `getFracRegAccountsMap`
 * already takes an array, so the wallet's accounts and their delegators cost one
 * call between them. Unregistered accounts are dropped rather than kept as zeros.
 *
 * Overlaps {@link useFracAccount} for a single account (different key, same box).
 * Deliberate: that hook is the account page's 1-read short-circuit and is shared
 * with `usePooledPositions`, while this one batches. The duplicate is one read.
 */
export function useFracAccountsMap(accounts: string[]): {
  byAccount: Record<string, FracRegAccount>
  isLoading: boolean
} {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { data, isPending, fetchStatus } = useQuery({
    queryKey: queryKeys.fracAccounts(accounts),
    queryFn: async (): Promise<Record<string, FracRegAccount>> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return {}
      const map = await sdk.registry.getFracRegAccountsMap(accounts)
      const out: Record<string, FracRegAccount> = {}
      for (const [account, record] of map) {
        // accountId 0 is the registry's "unknown account" sentinel.
        if (record && record.accountId > 0) out[account] = record
      }
      return out
    },
    enabled: fracEnabled && accounts.length > 0,
    staleTime: 60_000,
  })
  return { byAccount: data ?? {}, isLoading: isPending && fetchStatus !== 'idle' }
}

/**
 * Per account, its AlgoQuarters standing in *one* committee across every instance
 * it belongs to. The transpose of {@link usePooledCommitteeAqs} — and it reuses
 * that hook's query key, so an account already read by the account page is free
 * here (and vice versa).
 */
export function usePooledCommitteeAqForAccounts(
  accounts: string[],
  committeeIdBase64Url: string | undefined,
): { byAccount: Record<string, FracAccountCommitteeAq[]>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.fracAccountCommitteeAq(account, committeeIdBase64Url ?? ''),
      queryFn: async (): Promise<FracAccountCommitteeAq[]> => {
        const sdk = await getFracReaderSDK()
        if (!sdk) return []
        const entries = await sdk.registry.getAccountInstanceAQs(account, fromBase64Url(committeeIdBase64Url!))
        return entries.filter((e) => e.userAq > 0 && e.totalAq > 0)
      },
      enabled: fracEnabled && !!committeeIdBase64Url,
      staleTime: 60_000,
    })),
  })

  const byAccount: Record<string, FracAccountCommitteeAq[]> = {}
  accounts.forEach((account, i) => {
    const data = results[i]?.data
    if (data?.length) byAccount[account] = data
  })
  return { byAccount, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

/** One (instance, voter, sender) triple to check for pooled-vote eligibility. */
export interface FracCanVoteEntry {
  instanceNumId: number
  /** The account whose AlgoQuarters would be cast. */
  voter: string
  /** The account that would sign — `voter` itself, or its gGov delegatee. */
  sender: string
}

/**
 * Whether each (instance, voter, sender) may cast a pooled ballot on this period,
 * and the AlgoQuarters weight it would carry. This is the authoritative gate: the
 * contract's `canVote` mirrors every check `vote()` enforces — period synced on
 * the instance, gGov period ready and inside its window, committee ids matching,
 * the AQ ledger complete, non-zero AQ, and for a delegated cast both the
 * delegation and the no-direct-vote override guard.
 *
 * TODO(perf): one read per position, because `canVote` is instance-scoped and
 * single-voter. The registry already has the right shape for the batched version —
 * `logAccountVotingRecords` pages one account across all its instances — so the
 * fix is its sibling `logAccountCanVote(account, senderAccount, periodId, limit,
 * offset)` emitting `[instanceNumId, canVote, aqWeight]` per instance, which
 * collapses this to one read per account. Contract work, so a follow-up; see the
 * two TODOs above for the same argument applied to the account page.
 */
export function useFracCanVoteMany(
  entries: FracCanVoteEntry[],
  periodId: number,
): { byKey: Record<string, [boolean, bigint]>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const results = useQueries({
    queries: entries.map((entry) => ({
      queryKey: queryKeys.fracCanVote(periodId, entry.instanceNumId, entry.voter, entry.sender),
      queryFn: async (): Promise<[boolean, bigint]> => {
        const sdk = await getFracReaderSDK()
        if (!sdk) return [false, 0n]
        return sdk.canVote(entry.instanceNumId, periodId, entry.voter, entry.sender)
      },
      enabled: fracEnabled,
      // Eligibility turns on the voting window and the pool's ingest state, both of
      // which move without any action from this user — keep it short-lived.
      staleTime: 30_000,
    })),
  })

  const byKey: Record<string, [boolean, bigint]> = {}
  entries.forEach((entry, i) => {
    const data = results[i]?.data
    if (data) byKey[canVoteKey(entry)] = data
  })
  return { byKey, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

const canVoteKey = (e: FracCanVoteEntry) => `${e.instanceNumId}:${e.voter}:${e.sender}`

/**
 * Each account's pooled vote records for a period, keyed by instance. One paged
 * read per account covers *every* instance that account belongs to — this is
 * already the batched cross-instance reader, so unlike the hooks above there is
 * no fan-out to remove: the remaining per-account calls are inherent, the record
 * living in a per-account box.
 *
 * An instance the account has not voted on comes back with empty `topicVotes`,
 * which is filtered out here so a present entry always means "voted".
 */
export function useFracVotingRecords(
  accounts: string[],
  periodId: number,
): { byAccount: Record<string, Record<number, FracAccountVotingRecord>>; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.fracVotingRecords(account, periodId),
      queryFn: async (): Promise<Record<number, FracAccountVotingRecord>> => {
        const sdk = await getFracReaderSDK()
        if (!sdk) return {}
        const records = await sdk.registry.getAccountVotingRecords(account, periodId)
        const out: Record<number, FracAccountVotingRecord> = {}
        for (const record of records) {
          if (record.topicVotes.length > 0) out[record.instanceNumId] = record
        }
        return out
      },
      enabled: fracEnabled,
      staleTime: 30_000,
    })),
  })

  const byAccount: Record<string, Record<number, FracAccountVotingRecord>> = {}
  accounts.forEach((account, i) => {
    const data = results[i]?.data
    if (data) byAccount[account] = data
  })
  return { byAccount, isLoading: results.some((r) => r.isPending && r.fetchStatus !== 'idle') }
}

/** One selectable pooled position on a period's ballot. */
export interface PooledBallotPosition {
  /**
   * Selection key, `{instanceNumId}:{owner}`. Shares a namespace with plain
   * account addresses in the selector, which is safe — no address contains a ':'.
   */
  id: string
  instanceNumId: number
  instanceName: string
  /** The account whose AlgoQuarters this position casts. */
  owner: string
  /** Whether `owner` is one of the connected wallet's own accounts. */
  ownerIsSelf: boolean
  /** The account that must sign: `owner` itself, or the delegatee it points at. */
  sender: string
  userAq: number
  totalAq: number
  /** `userAq / totalAq * 100`. */
  sharePct: number
  /** The pool's own gGov power for this committee. */
  poolVotes: number
  /** `sharePct / 100 * poolVotes` — approximate, see this module's docblock. */
  votes: number
  /** Authoritative eligibility; `undefined` while the check is in flight. */
  canVote?: boolean
  /** AlgoQuarters this ballot must allocate per topic. `undefined` until `canVote` lands. */
  aqWeight?: bigint
  hasVoted: boolean
  /**
   * The recorded ballot as submitted — [topic][option] AlgoQuarters — when
   * `hasVoted`. Comes along with the eligibility reads, so displaying it is free.
   */
  topicVotes?: number[][]
  /**
   * The owner cast this pool's vote itself, so a delegatee cannot overwrite it
   * (the contract's override guard). Only meaningful when `sender !== owner`.
   */
  votedDirectly: boolean
  /**
   * Has stake but cannot vote for a reason on the *pool's* side — the pool hasn't
   * synced this period yet, or its AlgoQuarters ledger is still being ingested.
   * Worth distinguishing: the member's own standing is fine, so "not eligible"
   * would misplace the blame. `canVote` collapses every rejection into false, so
   * this is inferred rather than read.
   */
  poolNotReady: boolean
}

export interface PooledBallot {
  /** Strongest first, grouped by owner. */
  positions: PooledBallotPosition[]
  byId: Record<string, PooledBallotPosition>
  isLoading: boolean
  fracEnabled: boolean
}

const EMPTY_BALLOT_POSITIONS: PooledBallotPosition[] = []

/**
 * Every pooled position the connected wallet can act on for one period: its own
 * accounts' pools, plus the pools of any account that delegated to it.
 *
 * `voters` is the accounts to resolve (own + delegators) and `senderOf` maps each
 * to the account that signs for it — itself for an own account, its delegatee for
 * a delegator. That mapping is what makes a delegated pooled vote possible, and
 * what `canVote` is checked against.
 *
 * Positions are held back until both the AlgoQuarters and the pool's committee
 * snapshot have resolved: a pool that never synced the committee has no share to
 * cast, so emitting rows early would mean rendering some only to remove them.
 */
export function usePooledBallot({
  periodId,
  committeeIdBase64Url,
  voters,
  senderOf,
  isActive,
}: {
  periodId: number
  committeeIdBase64Url?: string
  voters: string[]
  senderOf: Record<string, string>
  /** Whether the period's voting window is open — gates the `poolNotReady` inference. */
  isActive: boolean
}): PooledBallot {
  const { fracEnabled } = useGGovSDK()

  const { byAccount: fracAccounts, isLoading: accountsLoading } = useFracAccountsMap(voters)
  // Only accounts the frac registry knows can hold a pooled position.
  const registered = voters.filter((v) => fracAccounts[v] !== undefined)
  const instanceNumIds = Array.from(new Set(registered.flatMap((v) => fracAccounts[v]!.instanceNumIds)))

  const committeeIds = committeeIdBase64Url ? [committeeIdBase64Url] : []
  const { byInstance, isLoading: committeesLoading } = useFracInstanceCommittees(instanceNumIds, committeeIds)
  const { byAccount: aqByAccount, isLoading: aqLoading } = usePooledCommitteeAqForAccounts(
    registered,
    committeeIdBase64Url,
  )

  // Positions, before eligibility and vote records are folded in. Order follows
  // `voters`, so a row sits under the account it belongs to in the selector.
  const base = committeeIdBase64Url
    ? voters.flatMap((owner) =>
        (aqByAccount[owner] ?? []).flatMap((entry) => {
          const poolVotes = byInstance[entry.instanceNumId]?.[committeeIdBase64Url]?.totalVotes
          if (!poolVotes) return []
          const sharePct = (entry.userAq / entry.totalAq) * 100
          return [
            {
              instanceNumId: entry.instanceNumId,
              instanceName: entry.instanceName,
              owner,
              sharePct,
              poolVotes,
              userAq: entry.userAq,
              totalAq: entry.totalAq,
              votes: (sharePct / 100) * poolVotes,
            },
          ]
        }),
      )
    : []

  const { byKey: canVoteByKey, isLoading: canVoteLoading } = useFracCanVoteMany(
    base.map((p) => ({ instanceNumId: p.instanceNumId, voter: p.owner, sender: senderOf[p.owner] ?? p.owner })),
    periodId,
  )
  const { byAccount: recordsByAccount, isLoading: recordsLoading } = useFracVotingRecords(registered, periodId)

  const positions: PooledBallotPosition[] = base.map((p) => {
    const sender = senderOf[p.owner] ?? p.owner
    const eligibility = canVoteByKey[canVoteKey({ instanceNumId: p.instanceNumId, voter: p.owner, sender })]
    const record = recordsByAccount[p.owner]?.[p.instanceNumId]
    const hasVoted = record !== undefined
    const votedDirectly = record !== undefined && !record.isDelegated
    // A delegatee blocked by the owner's own vote is already covered by the
    // selector's "locked" state, so don't also blame the pool for it.
    const lockedByOwner = sender !== p.owner && votedDirectly
    return {
      ...p,
      id: `${p.instanceNumId}:${p.owner}`,
      // A missing `senderOf` entry falls back to self-signing, same as `sender`.
      ownerIsSelf: sender === p.owner,
      sender,
      canVote: eligibility?.[0],
      aqWeight: eligibility?.[1],
      hasVoted,
      topicVotes: record?.topicVotes,
      votedDirectly,
      poolNotReady: isActive && eligibility?.[0] === false && !lockedByOwner,
    }
  })

  const byId: Record<string, PooledBallotPosition> = {}
  for (const position of positions) byId[position.id] = position

  return {
    positions: positions.length ? positions : EMPTY_BALLOT_POSITIONS,
    byId,
    isLoading:
      fracEnabled &&
      (accountsLoading ||
        (registered.length > 0 && (committeesLoading || aqLoading)) ||
        (base.length > 0 && (canVoteLoading || recordsLoading))),
    fracEnabled,
  }
}

// ─── One pool (the pool detail page) ─────────────────────────────────────────
//
// The hooks above answer "which pools" and "how much power". This section
// answers "who is in one of them, and how did they vote" — the only question in
// this module the contracts have no batched reader for, so it is also the only
// one that costs a scan. See `useFracRoster`.

/** One member of a pool, with the stake it holds in one committee. */
export interface PoolMember {
  address: string
  /** Frac registry numeric account id — the handle every instance-side read takes. */
  accountId: number
  /** AlgoQuarters this account holds in the committee. Always > 0 here. */
  aq: number
}

const EMPTY_MEMBERS: PoolMember[] = []

/**
 * Every account the frac registry knows, with its numeric id and the instances it
 * belongs to.
 *
 * TODO(perf): this is the one genuinely expensive read in the module, and it is
 * registry-wide rather than pool-scoped: a box-name scan of the registry
 * (`getAccounts`) followed by `logAccounts` batched 126 per simulate group, so it
 * costs ~N/126 round-trips in the *registry's* account count — not the pool's.
 * There is no cheaper path today, because nothing on chain maps an instance to
 * its members: `FracInstance` counts them (`numAccounts`) without listing them,
 * and the instance's own `accountAq` BoxMap is keyed by numeric account id with
 * no reverse id → address map anywhere. Wanted, on the registry:
 * `logInstanceAccounts(instanceNumId, limit, offset)` emitting `[accountId,
 * account]` per member, paged like `logAccountInstanceAq`. That turns this into a
 * read proportional to the pool. Contract work, so a follow-up.
 *
 * Cached hard and account-independent, so it is read once per session however
 * many pools are visited, and the AlgoQuarters read it feeds is pool-sized.
 */
export function useFracRoster(): { roster: Map<string, FracRegAccount> | undefined; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { data, isPending, fetchStatus } = useQuery({
    queryKey: queryKeys.fracRoster,
    queryFn: async (): Promise<Map<string, FracRegAccount>> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return new Map()
      const map = await sdk.registry.getFracRegAccountsMap()
      // accountId 0 is the registry's "unknown account" sentinel; a box-name scan
      // should never produce one, but a record carrying it is not addressable.
      for (const [account, record] of map) if (record.accountId === 0) map.delete(account)
      return map
    },
    enabled: fracEnabled,
    // Accounts are only ever added to the registry, and one that joins mid-window
    // still holds no AlgoQuarters in a committee already ingested.
    staleTime: 600_000,
  })
  return { roster: data, isLoading: isPending && fetchStatus !== 'idle' }
}

/**
 * One pool's members in one committee, ranked by stake.
 *
 * Two reads joined: the registry roster says who is in the instance at all
 * ({@link useFracRoster}), and the instance's AlgoQuarters ledger says what each
 * of them held during the window. Only the second is pool-sized, and it is the
 * one keyed per committee — the roster is shared across every pool page.
 *
 * Members with no AlgoQuarters are dropped rather than listed at zero: they
 * joined the pool after the window closed, or the ingest has not reached them,
 * and neither carries voting power here. The survivors are exactly the `stakers`
 * count {@link useCommitteePools} reports for the pool.
 */
export function usePoolMembers(
  instanceNumId: number | undefined,
  committeeNumId: number | undefined,
  committeeIdBase64Url: string | undefined,
): { members: PoolMember[]; isLoading: boolean; isError: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { roster, isLoading: rosterLoading } = useFracRoster()

  // Derived out here rather than inside `queryFn`, because it is also what keys
  // the query: the roster is its own cache entry, and membership is what this one
  // actually depends on. Keying on the roster's *size* would miss an account that
  // was already registered and merely joined this instance.
  const inPool = useMemo(() => {
    const members: { address: string; accountId: number }[] = []
    if (!roster || !instanceNumId) return members
    for (const [address, record] of roster) {
      if (record.instanceNumIds.includes(instanceNumId)) members.push({ address, accountId: record.accountId })
    }
    return members
  }, [roster, instanceNumId])

  const { data, isPending, fetchStatus, isError } = useQuery({
    queryKey: queryKeys.fracPoolMembers(
      instanceNumId ?? 0,
      committeeIdBase64Url ?? '',
      inPool.map((m) => m.accountId),
    ),
    queryFn: async (): Promise<PoolMember[]> => {
      const sdk = await getFracReaderSDK()
      if (!sdk || !roster) return []
      if (inPool.length === 0) return []
      // Index-aligned with the ids we passed; batched 126 per simulate group by the SDK.
      const aqs = await sdk.getAccountAqs(
        instanceNumId!,
        committeeNumId!,
        inPool.map((m) => m.accountId),
      )
      return inPool
        .map((m, i) => ({ ...m, aq: aqs[i] ?? 0 }))
        .filter((m) => m.aq > 0)
        .sort((a, b) => b.aq - a.aq)
    },
    enabled: fracEnabled && !!roster && !!instanceNumId && !!committeeNumId && !!committeeIdBase64Url,
    // Window-scoped and closed once the ingest completes, like the committee reads.
    staleTime: 300_000,
  })

  return {
    members: data ?? EMPTY_MEMBERS,
    // The roster gates the AlgoQuarters read, so it is still "loading members" while it runs.
    isLoading: rosterLoading || (isPending && fetchStatus !== 'idle'),
    isError,
  }
}

/**
 * Several members' internal vote records on one pool and period, in one read —
 * `topicVotes` is [topic][option] in AlgoQuarters, exactly as submitted, and an
 * account that has not voted is absent.
 *
 * The SDK packs one `getVotingRecord` call per account into a single simulate
 * group (16 per group, the group's transaction capacity), so a page of members
 * costs one round-trip rather than one each. Pass the rendered page, not the
 * whole roster: the group count still scales with the list.
 *
 * TODO(perf): 16 per group is the ceiling because the instance has no
 * `logVotingRecords(periodId, accountIds[])` — the direct sibling of the
 * `logAccountAqs` this page's stake column already uses, which would put a whole
 * page of members in one call rather than one group. Contract work, so a follow-up.
 */
export function usePoolMemberRecords(
  instanceNumId: number | undefined,
  periodId: number | undefined,
  accountIds: number[],
): { byAccountId: Record<number, FracVotingRecord>; isLoading: boolean; isError: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { data, isPending, fetchStatus, isError } = useQuery({
    queryKey: queryKeys.fracPoolVotingRecords(instanceNumId ?? 0, periodId ?? 0, accountIds),
    queryFn: async (): Promise<Record<number, FracVotingRecord>> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return {}
      const records = await sdk.getVotingRecords(instanceNumId!, periodId!, accountIds)
      const out: Record<number, FracVotingRecord> = {}
      accountIds.forEach((accountId, i) => {
        const record = records[i]
        if (record) out[accountId] = record
      })
      return out
    },
    enabled: fracEnabled && !!instanceNumId && periodId !== undefined && accountIds.length > 0,
    // Moves while the period is open, like the pool's own tally.
    staleTime: 30_000,
  })
  // An absent record means "has not voted", so a failed read would otherwise be
  // indistinguishable from a page of members who all abstained: `isError` is what
  // lets the caller say "unavailable" instead of asserting a vote nobody cast.
  return { byAccountId: data ?? {}, isLoading: isPending && fetchStatus !== 'idle', isError }
}

/**
 * The escrow accounts a pool's gGov voting power is produced from. One read, and
 * the input to {@link usePoolProtocolApps}.
 */
export function usePoolEscrows(instanceNumId: number | undefined): { escrows: string[]; isLoading: boolean } {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  const { data, isPending, fetchStatus } = useQuery({
    queryKey: queryKeys.fracInstanceEscrows(instanceNumId ?? 0),
    queryFn: async (): Promise<string[]> => {
      const sdk = await getFracReaderSDK()
      if (!sdk) return []
      return sdk.getEscrows(instanceNumId!)
    },
    enabled: fracEnabled && !!instanceNumId,
    // Escrows are registered once and only change by an admin `registerEscrow`.
    staleTime: 600_000,
  })
  return { escrows: data ?? EMPTY_ESCROWS, isLoading: isPending && fetchStatus !== 'idle' }
}

const EMPTY_ESCROWS: string[] = []
const EMPTY_APPS: bigint[] = []

/**
 * The applications a pool's escrows belong to — the protocol behind the pool,
 * named by app id rather than by the instance's free-form label.
 *
 * Two ways an escrow reaches an app, and both are tried:
 *
 * 1. The escrow *is* an application account, which Escreg resolves directly
 *    (escrow address → app id; the addresses are derived from the app id, so this
 *    is a lookup rather than a guess).
 * 2. The escrow is a plain account **rekeyed to** an application — the shape a
 *    protocol uses when block-producing accounts have to stay ordinary accounts.
 *    Its `auth-addr` is then the app's escrow, so resolving *that* through Escreg
 *    yields the app.
 *
 * The second pass costs one algod account read per unresolved escrow, so it only
 * runs for escrows Escreg could not place. An escrow that is neither is simply
 * absent from the result: it produces blocks for no application, which is a fact
 * about the pool rather than a gap in the data.
 *
 * This works on every network, including LocalNet: with `VITE_ESCREG_APP_ID`
 * unset the SDK falls back to its built-in Fnet registry, and that is not a
 * degraded mode — an app escrow address is derived from the app id alone, so the
 * mapping is network-independent and one registry answers for all of them.
 * A lookup that fails outright resolves to nothing rather than failing the fact,
 * the same way `useAppEscrow` degrades an unresolvable escrow to a plain account.
 */
export function usePoolProtocolApps(instanceNumId: number | undefined): {
  appIds: bigint[]
  isLoading: boolean
} {
  const { escregSDK, readerSDK } = useGGovSDK()
  const { escrows, isLoading: escrowsLoading } = usePoolEscrows(instanceNumId)

  const { data, isPending, fetchStatus } = useQuery({
    queryKey: queryKeys.fracProtocolApps(escrows),
    queryFn: async (): Promise<bigint[]> => {
      // An unreachable registry resolves nothing rather than failing the fact.
      const lookup = async (addresses: string[]) => {
        try {
          return await escregSDK.lookup({ addresses })
        } catch {
          return {}
        }
      }

      // Pass 1: escrows that are themselves application accounts.
      const direct = await lookup(escrows)
      const apps = new Set<bigint>()
      const rekeyed: string[] = []
      for (const escrow of escrows) {
        const appId = direct[escrow]
        if (appId) apps.add(appId)
        else rekeyed.push(escrow)
      }

      // Pass 2: the rest may be plain accounts rekeyed to an application.
      if (rekeyed.length > 0) {
        const authAddrs = await Promise.all(
          rekeyed.map(async (escrow) => {
            try {
              const info = await readerSDK.algorand.client.algod.accountInformation(escrow).do()
              return info.authAddr?.toString()
            } catch {
              // A never-funded escrow has no account to read; it has no app either.
              return undefined
            }
          }),
        )
        const distinct = [...new Set(authAddrs.filter((addr): addr is string => !!addr))]
        if (distinct.length > 0) {
          const indirect = await lookup(distinct)
          for (const appId of Object.values(indirect)) if (appId) apps.add(appId)
        }
      }

      return [...apps].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    },
    enabled: escrows.length > 0,
    // Rekey targets can change, but only by the protocol re-pointing its accounts.
    staleTime: 600_000,
  })

  return {
    appIds: data ?? EMPTY_APPS,
    isLoading: escrowsLoading || (isPending && fetchStatus !== 'idle'),
  }
}
