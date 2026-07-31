import { useQueries, useQuery } from '@tanstack/react-query'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { fromBase64Url, queryKeys } from '@/hooks/queries'
import type {
  FracAccountCommitteeAq,
  FracAccountVotingRecord,
  FracInstanceCommittee,
  FracRegAccount,
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
 * across an account's instances), so the fix is a registry-side
 * `logInstanceCommittees(instanceNumIds[], committeeIds[], limit, offset)`.
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
      queryKey: queryKeys.fracInstanceCommittees(instanceNumId, committeeIdsBase64Url.length),
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
