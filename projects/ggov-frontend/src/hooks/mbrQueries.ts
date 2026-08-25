import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { getApplicationAddress } from 'algosdk'
import { voteRecordBoxMbr } from 'ggov-sdk'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { queryKeys, toBase64Url, useAllDelegations, useCommittees, useGlobalState, usePeriods } from '@/hooks/queries'
import { fetchCommitteePools } from '@/hooks/fracQueries'
import { fracRegistryAppId, getFracVotingRecordKeyLength } from '@/lib/fracReaderSdk'
import { registryAppId } from '@/lib/readerSdk'
import {
  estimateFracRegistry,
  estimateGgovRegistry,
  countsTowardMbr,
  optionCountsOf,
  shortfallOf,
  spendable,
  splitUndelegated,
  type CountedPool,
  type FracMbrEstimate,
  type GgovMbrEstimate,
} from '@/lib/mbrEstimate'

/**
 * Reads behind the registry-funding panel on `/manage`.
 *
 * Its own module rather than a slice of `queries.ts` for the same reason `fracQueries.ts` is one: it
 * spans both registries and the manage page is its only consumer, so a visitor who never opens
 * `/manage` pays nothing for it. The arithmetic lives in `lib/mbrEstimate.ts`; this file only
 * fetches.
 *
 * Most of the inputs already have hooks — periods, committees, delegations, registry globals, pool
 * standings. What is genuinely new is reading an *application account's* balance, which no reader
 * method covers, so it goes to algod directly through the SDK's client (same escape hatch
 * `fracQueries.ts` uses for escrow balances).
 */

/** Balance and min-balance of an application's account, in µAlgo. */
export interface AppAccountInfo {
  amount: bigint
  minBalance: bigint
}

/**
 * Balance + min-balance for a set of application accounts, keyed by app id.
 *
 * TODO(perf): one algod `accountInformation` per app — the registry, every counted period, and every
 * pool instance. Small N in practice (a handful of live periods and pools) and each entry is cached
 * on its own key, but a batched account reader on the SDK, alongside the batched box readers, would
 * collapse the whole panel's balance reads into one round-trip.
 */
export function useAppAccountInfos(appIds: bigint[]): {
  byAppId: Map<string, AppAccountInfo>
  isLoading: boolean
} {
  const { readerSDK } = useGGovSDK()

  const results = useQueries({
    queries: appIds.map((appId) => ({
      queryKey: queryKeys.appAccountInfo(appId),
      queryFn: async (): Promise<AppAccountInfo> => {
        const info = await readerSDK.algorand.client.algod.accountInformation(getApplicationAddress(appId)).do()
        return { amount: BigInt(info.amount), minBalance: BigInt(info.minBalance) }
      },
      // Balances move with every vote, and this panel exists to catch one running low — short
      // enough to reflect a top-up on the next visit, long enough not to poll algod per render.
      staleTime: 15_000,
    })),
  })

  // `results` is a fresh array every render, so it cannot be a dependency itself. Fold the part
  // that matters — which app, at what balance — into one string and memoise on that.
  const signature = results.map((r, i) => `${appIds[i]}:${r.data?.amount ?? ''}:${r.data?.minBalance ?? ''}`).join('|')
  const isLoading = results.some((r) => r.isPending && r.fetchStatus !== 'idle')

  const byAppId = useMemo(() => {
    const map = new Map<string, AppAccountInfo>()
    for (const entry of signature.split('|')) {
      const [appId, amount, minBalance] = entry.split(':')
      if (amount) map.set(appId, { amount: BigInt(amount), minBalance: BigInt(minBalance) })
    }
    return map
  }, [signature])

  return { byAppId, isLoading }
}

/** Frac registry global state — read here only for `mbrTopUp`. */
export function useFracGlobalState() {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.fracGlobalState,
    queryFn: async () => {
      const sdk = await getFracReaderSDK()
      return sdk ? sdk.registry.getGlobalState() : null
    },
    enabled: fracEnabled,
    staleTime: 60_000,
  })
}

/**
 * Every address the gGov registry holds an `accounts` box for.
 *
 * TODO(perf): this and `useAllDelegations` each run their own `getBoxNames` scan over the same
 * registry app, and the panel needs both. One scan classified by key prefix — the SDK already
 * filters `'a'` and `'d'` out of an identical listing — would halve the paging.
 */
export function useGGovAccounts() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.ggovAccounts,
    queryFn: () => readerSDK.registry.getAccounts(),
    // Grows only when the admin ingests a committee, same cadence as `useAllDelegations`.
    staleTime: 600_000,
  })
}

/**
 * Every address the frac registry holds an `accounts` box for — the AQ holders.
 *
 * These are delegators the gGov registry must be able to pay for even though it has never heard of
 * them: `ensureDelegatorRegistered` falls back to this roster. Empty on a network with no frac
 * registry, which collapses the pooled term to nothing.
 */
export function useFracRegistryAccounts() {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.fracRegistryAccounts,
    queryFn: async () => {
      const sdk = await getFracReaderSDK()
      return sdk ? sdk.registry.getAccounts() : []
    },
    enabled: fracEnabled,
    staleTime: 600_000,
  })
}

export interface RegistryMbr {
  /** The registry's own app account. */
  appId: bigint
  amount: bigint
  minBalance: bigint
  /** `amount - minBalance` — what it can actually pay out. */
  spendable: bigint
  /** Worst-case MBR it must be able to supply. */
  required: bigint
  /** `required - spendable`, floored at 0. */
  shortfall: bigint
}

export interface MbrEstimates {
  ggov: RegistryMbr & { detail: GgovMbrEstimate }
  /** Null on a network with no frac registry. */
  frac: (RegistryMbr & { detail: FracMbrEstimate }) | null
  /** Periods counted into both estimates — ready and not yet ended, drafts excluded. */
  countedPeriodCount: number
  isLoading: boolean
}

/**
 * Worst-case MBR both registries must be able to supply, at a given turnout assumption.
 *
 * `turnoutPct` scales the **voting** term only. The delegation term is unconditional: the
 * requirement is that every account eligible to delegate can, so dialling turnout down must not make
 * that obligation look smaller than it is.
 */
export function useMbrEstimates(turnoutPct: number): MbrEstimates {
  const { fracEnabled, getFracReaderSDK } = useGGovSDK()

  const { data: periods = [], isLoading: periodsLoading } = usePeriods()
  const { data: committees = [], isLoading: committeesLoading } = useCommittees()
  const { data: globalState, isLoading: globalLoading } = useGlobalState()
  const { data: delegations, isLoading: delegationsLoading } = useAllDelegations()
  const { data: fracGlobalState, isLoading: fracGlobalLoading } = useFracGlobalState()
  const { data: ggovAccounts, isLoading: ggovAccountsLoading } = useGGovAccounts()
  const { data: fracAccounts, isLoading: fracAccountsLoading } = useFracRegistryAccounts()

  // The clock is read inside the memo, not as a dependency: a `now` that ticks every render would
  // hand every downstream memo — committee ids, app ids, pool rows — a fresh array each time. The
  // list re-evaluates when `periods` refetches, which is soon enough for a period ending.
  const countedPeriods = useMemo(() => {
    const now = Math.floor(Date.now() / 1000)
    return periods.filter(({ period, ready }) => countsTowardMbr({ ready, votingEnd: period.votingEnd }, now))
  }, [periods])

  const committeeById = useMemo(() => new Map(committees.map((c) => [c.idBase64Url, c])), [committees])

  // An unloaded roster reads as empty here, which would understate both delegation terms — the
  // panel's `isLoading` covers that window, and it now waits on these two reads as well.
  const undelegated = useMemo(
    () => splitUndelegated(ggovAccounts ?? [], fracAccounts ?? [], delegations?.keys() ?? []),
    [ggovAccounts, fracAccounts, delegations],
  )

  // Every app account the panel prices: both registries, each counted period, and (below) each pool
  // instance. One list so they share a single `useQueries` pass.
  const countedCommitteeIds = useMemo(
    () => [...new Set(countedPeriods.map(({ period }) => toBase64Url(period.committeeId)))],
    [countedPeriods],
  )

  const poolQueries = useQueries({
    queries: countedCommitteeIds.map((committeeIdBase64Url) => ({
      queryKey: queryKeys.fracCommitteePools(committeeIdBase64Url),
      queryFn: async () => fetchCommitteePools(await getFracReaderSDK(), committeeIdBase64Url),
      enabled: fracEnabled,
      staleTime: 300_000,
    })),
  })

  const { data: fracKeyLength } = useQuery({
    queryKey: ['fracVotingRecordKeyLength'] as const,
    queryFn: async () => (await getFracVotingRecordKeyLength()) ?? 0,
    enabled: fracEnabled,
    // A compiled-in constant; it cannot change while the tab is open.
    staleTime: Infinity,
  })

  // Same trick as `useAppAccountInfos`: a per-committee array of query results cannot be a
  // dependency, so key the memo on which committees resolved to which pools.
  const poolSignature = countedCommitteeIds
    .map((id, i) => `${id}:${(poolQueries[i]?.data?.pools ?? []).map((p) => p.instanceNumId).join('.')}`)
    .join('|')

  const poolsByCommittee = useMemo(() => {
    const map = new Map<string, ReturnType<typeof poolRowsOf>>()
    countedCommitteeIds.forEach((id, i) => {
      const data = poolQueries[i]?.data
      if (data) map.set(id, poolRowsOf(data.pools))
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolSignature])

  const instanceAppIds = useMemo(() => {
    const ids = new Set<string>()
    for (const rows of poolsByCommittee.values()) for (const row of rows) ids.add(String(row.appId))
    return [...ids].map(BigInt)
  }, [poolsByCommittee])

  // `registryAppId` / `fracRegistryAppId` are module constants from the Vite env, not reactive.
  const appIds = useMemo(() => {
    const ids = [registryAppId, ...countedPeriods.map((p) => p.appId), ...instanceAppIds]
    if (fracRegistryAppId !== undefined) ids.push(fracRegistryAppId)
    return ids
  }, [countedPeriods, instanceAppIds])

  const { byAppId, isLoading: balancesLoading } = useAppAccountInfos(appIds)

  const spendableOf = (appId: bigint): bigint | undefined => {
    const info = byAppId.get(String(appId))
    return info ? spendable(info.amount, info.minBalance) : undefined
  }

  const ggovDetail = estimateGgovRegistry({
    periods: countedPeriods.map((p) => ({
      periodId: p.id,
      optionCounts: optionCountsOf(p.period),
      members: committeeById.get(toBase64Url(p.period.committeeId))?.totalMembers ?? 0,
      childSpendable: spendableOf(p.appId),
    })),
    undelegated,
    mbrTopUp: globalState?.mbrTopUp ?? 0n,
    turnoutPct,
  })

  const fracPools: CountedPool[] = useMemo(() => {
    if (!fracEnabled || !fracKeyLength) return []
    const rows: CountedPool[] = []
    for (const p of countedPeriods) {
      const pools = poolsByCommittee.get(toBase64Url(p.period.committeeId))
      if (!pools) continue
      const perVoter = voteRecordBoxMbr(fracKeyLength, optionCountsOf(p.period))
      for (const pool of pools) {
        rows.push({
          instanceNumId: pool.instanceNumId,
          name: pool.name,
          // Committee-scoped stakers when an AQ ledger is open; the pool's roster otherwise, so a
          // future period whose committee is not ingested yet does not read as zero voters.
          members: pool.stakers > 0 ? pool.stakers : pool.members,
          perVoter,
          childSpendable: spendableOf(BigInt(pool.appId)),
        })
      }
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fracEnabled, fracKeyLength, countedPeriods, poolsByCommittee, byAppId])

  const fracDetail = estimateFracRegistry({
    pools: fracPools,
    mbrTopUp: fracGlobalState?.mbrTopUp ?? 0n,
    turnoutPct,
  })

  const registryInfo = byAppId.get(String(registryAppId))
  const ggovSpendable = registryInfo ? spendable(registryInfo.amount, registryInfo.minBalance) : 0n

  const fracInfo = fracRegistryAppId !== undefined ? byAppId.get(String(fracRegistryAppId)) : undefined
  const fracSpendable = fracInfo ? spendable(fracInfo.amount, fracInfo.minBalance) : 0n

  return {
    ggov: {
      appId: registryAppId,
      amount: registryInfo?.amount ?? 0n,
      minBalance: registryInfo?.minBalance ?? 0n,
      spendable: ggovSpendable,
      required: ggovDetail.required,
      shortfall: shortfallOf(ggovDetail.required, ggovSpendable),
      detail: ggovDetail,
    },
    frac:
      fracRegistryAppId === undefined
        ? null
        : {
            appId: fracRegistryAppId,
            amount: fracInfo?.amount ?? 0n,
            minBalance: fracInfo?.minBalance ?? 0n,
            spendable: fracSpendable,
            required: fracDetail.required,
            shortfall: shortfallOf(fracDetail.required, fracSpendable),
            detail: fracDetail,
          },
    countedPeriodCount: countedPeriods.length,
    isLoading:
      periodsLoading ||
      committeesLoading ||
      globalLoading ||
      delegationsLoading ||
      ggovAccountsLoading ||
      balancesLoading ||
      (fracEnabled &&
        (fracGlobalLoading || fracAccountsLoading || poolQueries.some((q) => q.isPending && q.fetchStatus !== 'idle'))),
  }
}

/** The pool fields the estimate needs, narrowed off `CommitteePool`. */
function poolRowsOf(pools: { instanceNumId: number; appId: bigint; name: string; members: number; stakers: number }[]) {
  return pools.map(({ instanceNumId, appId, name, members, stakers }) => ({
    instanceNumId,
    appId,
    name,
    members,
    stakers,
  }))
}
