import { useQueries, useQuery } from '@tanstack/react-query'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { fromBase64Url, queryKeys } from '@/hooks/queries'
import type { FracAccountCommitteeAq, FracInstanceCommittee, FracRegAccount } from 'frac-delegation-sdk'

/**
 * Pooled voting power — an account's share of the gGov power held by the staking
 * pools it belongs to (xALGO, tALGO, Reti). Kept in its own module rather than
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
