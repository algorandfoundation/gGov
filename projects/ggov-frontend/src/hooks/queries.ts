import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import type { GGovPeriod, BodyJson, GGovVoteRecord, AccountWithVotes } from 'ggov-sdk'

export interface PeriodWithId {
  id: number
  period: GGovPeriod
  /** Registry-summary view: whether the operator has marked this period ready for voting. */
  ready: boolean
}

export const queryKeys = {
  globalState: ['globalState'] as const,
  periods: ['periods'] as const,
  period: (id: number) => ['period', id] as const,
  periodAppId: (id: number) => ['periodAppId', id] as const,
  periodBody: (id: number) => ['periodBody', id] as const,
  topicBodies: (id: number) => ['topicBodies', id] as const,
  canVote: (periodId: number, account: string, sender = '') => ['canVote', periodId, account, sender] as const,
  canVoteMany: (periodId: number, key: string) => ['canVoteMany', periodId, key] as const,
  voteRecord: (periodId: number, account: string) => ['voteRecord', periodId, account] as const,
  delegation: (account: string) => ['delegation', account] as const,
  allDelegations: ['allDelegations'] as const,
  delegatedToMe: (account: string) => ['delegatedToMe', account] as const,
  committees: ['committees'] as const,
  committee: (id: string) => ['committee', id] as const,
  myVotes: (account: string) => ['myVotes', account] as const,
  committeeVotingPowers: (account: string) => ['committeeVotingPowers', account] as const,
  committeeMembers: (id: string) => ['committeeMembers', id] as const,
  xgovVotingPower: (committeeId: string, account: string) => ['xgovVotingPower', committeeId, account] as const,
}

export function useGlobalState() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.globalState,
    queryFn: () => readerSDK.getGlobalState(),
    staleTime: 60_000,
  })
}

export function usePeriods() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periods,
    queryFn: async (): Promise<PeriodWithId[]> => {
      const all = await readerSDK.getAllPeriods()
      return all.map(({ id, period, summary }) => ({
        id: Number(id),
        period,
        ready: summary.ready,
      }))
    },
  })
}

export function usePeriod(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.period(periodId),
    queryFn: () => readerSDK.getPeriod(BigInt(periodId)),
  })
}

/** On-chain app ID of the per-period GGovPeriod contract (for explorer links). */
export function usePeriodAppId(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periodAppId(periodId),
    queryFn: () => readerSDK.getPeriodAppId(BigInt(periodId)),
    staleTime: Infinity,
  })
}

export function usePeriodBody(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periodBody(periodId),
    queryFn: () => readerSDK.getPeriodBody(BigInt(periodId)),
    // Body is effectively immutable once uploaded; mutations that change it
    // (useUploadPeriodBodyMutation) invalidate this key, overriding staleTime.
    staleTime: 3_600_000,
  })
}

export function useTopicBodies(periodId: number, topicCount: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.topicBodies(periodId),
    queryFn: async (): Promise<(BodyJson | null)[]> => {
      return Promise.all(
        Array.from({ length: topicCount }, (_, i) =>
          readerSDK.getTopicBody(BigInt(periodId), BigInt(i))
        )
      )
    },
    enabled: topicCount > 0,
    // Topic bodies are immutable once uploaded; mutations that change them
    // (add/upload/remove topic) invalidate this key, overriding staleTime.
    staleTime: 3_600_000,
  })
}

export function useCanVote(
  periodId: number,
  account: string | null | undefined,
  senderAccount?: string | null,
) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.canVote(periodId, account ?? '', senderAccount ?? ''),
    queryFn: () => readerSDK.canVote(BigInt(periodId), account!, senderAccount ?? undefined),
    enabled: !!account,
  })
}

export function useVoteRecord(periodId: number, account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery<GGovVoteRecord | null>({
    queryKey: queryKeys.voteRecord(periodId, account ?? ''),
    queryFn: () => readerSDK.getVotingRecord(BigInt(periodId), account!),
    enabled: !!account,
  })
}

/**
 * Vote records for several accounts at once. Value per account: `true` voted,
 * `false` not voted, `undefined` while the record is still loading.
 */
export function useVoteStatuses(periodId: number, accounts: string[]): Record<string, boolean | undefined> {
  const { readerSDK } = useGGovSDK()
  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.voteRecord(periodId, account),
      queryFn: () => readerSDK.getVotingRecord(BigInt(periodId), account),
    })),
  })
  const statuses: Record<string, boolean | undefined> = {}
  accounts.forEach((account, i) => {
    const result = results[i]
    statuses[account] = result?.isSuccess ? !!result.data && result.data.topicVotes != null : undefined
  })
  return statuses
}

/**
 * Full vote records for several accounts at once (shares cache with
 * {@link useVoteStatuses}). Use when the `byDelegator` flag matters — e.g. to
 * tell whether a delegator voted directly, which a delegate cannot override.
 * Value per account: the record, `null` if not voted, `undefined` while loading.
 */
export function useVoteRecordMany(
  periodId: number,
  accounts: string[],
): Record<string, GGovVoteRecord | null | undefined> {
  const { readerSDK } = useGGovSDK()
  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.voteRecord(periodId, account),
      queryFn: () => readerSDK.getVotingRecord(BigInt(periodId), account),
    })),
  })
  const out: Record<string, GGovVoteRecord | null | undefined> = {}
  accounts.forEach((account, i) => {
    out[account] = results[i]?.isSuccess ? results[i].data : undefined
  })
  return out
}

/**
 * Voting eligibility + power for several accounts at once (one `canVote` read each).
 * `senderAccount` is the wallet that would submit the vote (self, or the delegate).
 * Value per account: `{ canVote, votingPower }`, or `undefined` while loading.
 *
 * `senderAccount` may be a single address (used for every account) or a map of
 * account → sender, so e.g. each delegator is checked against its own delegatee.
 */
export function useCanVoteMany(
  periodId: number,
  accounts: string[],
  senderAccount?: string | null | Record<string, string | undefined>,
): Record<string, { canVote: boolean; votingPower: bigint } | undefined> {
  const { readerSDK } = useGGovSDK()
  const queryClient = useQueryClient()
  const senderFor = (account: string): string | undefined =>
    senderAccount == null ? undefined : typeof senderAccount === 'string' ? senderAccount : senderAccount[account]
  // One batched read (16 canVote calls per simulate group) instead of one query per account.
  // Stable, order-independent cache key built from each (account, sender) pair.
  const senderKey = accounts.map((account) => `${account}:${senderFor(account) ?? ''}`).join(',')
  const { data } = useQuery({
    queryKey: queryKeys.canVoteMany(periodId, senderKey),
    queryFn: async () => {
      const results = await readerSDK.canVoteMany(BigInt(periodId), accounts, senderAccount ?? undefined)
      // Seed the per-account `canVote` cache so singular `useCanVote` reads hit warm data.
      accounts.forEach((account) => {
        queryClient.setQueryData(queryKeys.canVote(periodId, account, senderFor(account) ?? ''), results.get(account))
      })
      return results
    },
    enabled: accounts.length > 0,
  })
  const out: Record<string, { canVote: boolean; votingPower: bigint } | undefined> = {}
  accounts.forEach((account) => {
    out[account] = data?.get(account)
  })
  return out
}

export function useDelegation(account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.delegation(account ?? ''),
    queryFn: async () => {
      try {
        return await readerSDK.getDelegation(account!)
      } catch {
        return { delegatee: '', exists: false }
      }
    },
    enabled: !!account,
  })
}

export function useAllDelegations() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.allDelegations,
    queryFn: () => readerSDK.getAllDelegations(),
    staleTime: 600_000,
  })
}

/** Addresses that have delegated to `account` — a single reverse-index box read (`getDelegators`). */
export function useDelegatedToMe(account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.delegatedToMe(account ?? ''),
    queryFn: (): Promise<string[]> => readerSDK.getDelegators(account!),
    enabled: !!account,
  })
}

export interface CommitteeOption {
  id: Uint8Array
  idBase64Url: string
  periodStart: number
  periodEnd: number
  totalMembers: number
  totalVotes: number
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (str.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function useCommittees() {
  const { readerSDK } = useGGovSDK()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.committees,
    queryFn: async (): Promise<CommitteeOption[]> => {
      const ids = await readerSDK.getCommitteeIds()
      const options: CommitteeOption[] = []
      for (const id of ids) {
        const meta = await readerSDK.registry.getCommitteeMetadata(id)
        if (meta) {
          options.push({
            id,
            idBase64Url: toBase64Url(id),
            periodStart: meta.periodStart,
            periodEnd: meta.periodEnd,
            totalMembers: meta.totalMembers,
            totalVotes: meta.totalVotes,
          })
        }
      }
      options.sort((a, b) => b.periodStart - a.periodStart)
      // Seed the per-committee cache so useCommittee() reads warm data instead of
      // issuing its own metadata fetch.
      for (const option of options) {
        queryClient.setQueryData(queryKeys.committee(option.idBase64Url), option)
      }
      return options
    },
  })
}

/**
 * Single committee by id, backed by the same cache key {@link useCommittees}
 * seeds — so once the list has loaded this resolves instantly, and on a cold
 * load it fetches just this committee's metadata.
 */
export function useCommittee(idBase64Url: string | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.committee(idBase64Url ?? ''),
    queryFn: async (): Promise<CommitteeOption | null> => {
      const bytes = fromBase64Url(idBase64Url!)
      const meta = await readerSDK.registry.getCommitteeMetadata(bytes)
      if (!meta) return null
      return {
        id: bytes,
        idBase64Url: idBase64Url!,
        periodStart: meta.periodStart,
        periodEnd: meta.periodEnd,
        totalMembers: meta.totalMembers,
        totalVotes: meta.totalVotes,
      }
    },
    enabled: !!idBase64Url,
  })
}

/**
 * Window-independent xGov voting power for several accounts in one committee,
 * read from the registry (unlike {@link useCanVoteMany}, which returns 0 outside
 * the voting window). One readonly call per account, cached per (committee, account).
 * Value per account: the power, or `undefined` while loading.
 */
export function useXGovVotingPowers(
  committeeIdBase64Url: string | undefined,
  accounts: string[],
): Record<string, number | undefined> {
  const { readerSDK } = useGGovSDK()
  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.xgovVotingPower(committeeIdBase64Url ?? '', account),
      queryFn: async () => {
        const [power] = await readerSDK.registry.getXGovVotingPowers([fromBase64Url(committeeIdBase64Url!)], account)
        return power ?? 0
      },
      enabled: !!committeeIdBase64Url,
    })),
  })
  const out: Record<string, number | undefined> = {}
  accounts.forEach((account, i) => {
    out[account] = results[i]?.isSuccess ? results[i].data : undefined
  })
  return out
}

interface VoteEntry {
  periodId: number
  period: GGovPeriod
  record: GGovVoteRecord
  body: BodyJson | null
  topicBodies: (BodyJson | null)[]
}

export function useMyVotes(account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.myVotes(account ?? ''),
    queryFn: async (): Promise<VoteEntry[]> => {
      const results: VoteEntry[] = []
      const all = await readerSDK.getAllPeriods()
      for (const { id, period } of all) {
        try {
          const record = await readerSDK.getVotingRecord(id, account!)
          if (!record || record.topicVotes == null) continue
          const body = await readerSDK.getPeriodBody(id)
          const topicBodies = await Promise.all(
            Array.from({ length: period.topics.length }, (_, ti) =>
              readerSDK.getTopicBody(id, BigInt(ti)).catch(() => null)
            )
          )
          results.push({ periodId: Number(id), period, record, body, topicBodies })
        } catch { /* no vote for this period */ }
      }
      return results
    },
    enabled: !!account,
  })
}

export interface CommitteeVotingPower {
  idBase64Url: string
  periodStart: number
  periodEnd: number
  votingPower: number
}

export function useCommitteeVotingPowers(account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.committeeVotingPowers(account ?? ''),
    queryFn: async (): Promise<CommitteeVotingPower[]> => {
      const ids = await readerSDK.getCommitteeIds()
      // Two batched simulate groups instead of 2 serial on-chain reads per committee.
      const [metas, powers] = await Promise.all([
        readerSDK.registry.getCommitteesMetadata(ids),
        readerSDK.registry.getXGovVotingPowers(ids, account!),
      ])
      const results: CommitteeVotingPower[] = []
      for (let i = 0; i < ids.length; i++) {
        const meta = metas[i]
        if (!meta) continue
        const votingPower = powers[i] ?? 0
        if (votingPower === 0) continue // omit committees where the account has no voting power
        results.push({
          idBase64Url: toBase64Url(ids[i]),
          periodStart: meta.periodStart,
          periodEnd: meta.periodEnd,
          votingPower,
        })
      }
      results.sort((a, b) => b.periodStart - a.periodStart)
      return results
    },
    enabled: !!account,
  })
}

export function useCommitteeMembers(idBase64Url: string | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.committeeMembers(idBase64Url ?? ''),
    queryFn: async (): Promise<AccountWithVotes[]> => {
      const bytes = fromBase64Url(idBase64Url!)
      return readerSDK.registry.getCommitteeXGovs(bytes)
    },
    enabled: !!idBase64Url,
  })
}
