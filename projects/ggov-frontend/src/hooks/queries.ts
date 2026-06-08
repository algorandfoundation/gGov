import { useQuery } from '@tanstack/react-query'
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
  periodBody: (id: number) => ['periodBody', id] as const,
  topicBodies: (id: number) => ['topicBodies', id] as const,
  canVote: (periodId: number, account: string, sender = '') => ['canVote', periodId, account, sender] as const,
  voteRecord: (periodId: number, account: string) => ['voteRecord', periodId, account] as const,
  delegation: (account: string) => ['delegation', account] as const,
  allDelegations: ['allDelegations'] as const,
  delegatedToMe: (account: string) => ['delegatedToMe', account] as const,
  committees: ['committees'] as const,
  myVotes: (account: string) => ['myVotes', account] as const,
  committeeVotingPowers: (account: string) => ['committeeVotingPowers', account] as const,
  committeeMembers: (id: string) => ['committeeMembers', id] as const,
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
      const globalState = await readerSDK.getGlobalState()
      const count = Number(globalState.lastPeriodId ?? 0)
      if (count === 0) return []
      const periodIds = Array.from({ length: count }, (_, i) => BigInt(i + 1))
      const [summaries, periods] = await Promise.all([
        readerSDK.getPeriodSummaries(periodIds),
        readerSDK.getPeriods(periodIds),
      ])
      return periods.map((period, i) => ({
        id: i + 1,
        period,
        ready: summaries[i]?.ready ?? false,
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

export function usePeriodBody(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periodBody(periodId),
    queryFn: () => readerSDK.getPeriodBody(BigInt(periodId)),
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
      return options
    },
  })
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
      for (let i = 1; ; i++) {
        try {
          const period = await readerSDK.getPeriod(BigInt(i))
          if (period.votingStart === 0 && period.votingEnd === 0) break
          try {
            const record = await readerSDK.getVotingRecord(BigInt(i), account!)
            if (!record || record.topicVotes == null) continue
            const body = await readerSDK.getPeriodBody(BigInt(i))
            const topicBodies = await Promise.all(
              Array.from({ length: period.topics.length }, (_, ti) =>
                readerSDK.getTopicBody(BigInt(i), BigInt(ti)).catch(() => null)
              )
            )
            results.push({ periodId: i, period, record, body, topicBodies })
          } catch { /* no vote for this period */ }
        } catch {
          break
        }
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
      const results: CommitteeVotingPower[] = []
      for (const id of ids) {
        const meta = await readerSDK.registry.getCommitteeMetadata(id)
        if (!meta) continue
        const { return: power } = await readerSDK.registryReadClient.send.getXGovVotingPower({
          args: { committeeId: id, account: account! },
        })
        results.push({
          idBase64Url: toBase64Url(id),
          periodStart: meta.periodStart,
          periodEnd: meta.periodEnd,
          votingPower: power ?? 0,
        })
      }
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
