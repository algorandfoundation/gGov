/**
 * Storybook mock for `@/hooks/queries`.
 *
 * Aliased in `.storybook/main.ts` so the data-driven pages (landing, vote index,
 * vote detail) render without an SDK, provider or network. Every hook reads from
 * a {@link MockScenario} supplied through context by `MockScenarioProvider`
 * (mounted in `.storybook/preview.tsx`) and synthesises the exact return shape the
 * real hook produces.
 *
 * Results are derived directly from the current scenario on each render — not via
 * a cached `useQuery` — so flipping the `auth` / `periodPhase` toolbar globals
 * updates every story live. Singular results are memoised so the page effects that
 * depend on them (e.g. the self-eligibility fallback) don't re-run every render.
 *
 * The context + provider + hooks all live in THIS file: the alias makes
 * `@/hooks/queries` and the relative `./mocks/queries` import resolve to the same
 * module, guaranteeing one shared context instance (same pattern as the wallet mock).
 *
 * Module-identity note: pure helpers/types are re-exported from the REAL module by
 * an explicit relative path (NOT the `@/` alias), so there's no self-referential
 * recursion and the codecs match what the components compute.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { GGovVoteRecord } from 'ggov-sdk'
import { type MockScenario, pakey, cakey, emptyScenario } from './scenarios'

// Pure helpers + public types — single source of truth in the real module.
export { queryKeys, toBase64Url, fromBase64Url } from '../../src/hooks/queries'
export type {
  PeriodWithId,
  CommitteeOption,
  CommitteeVotingPower,
  ProducerRank,
  BlockHeaderInfo,
} from '../../src/hooks/queries'

// --- Scenario context --------------------------------------------------------

const MockScenarioContext = createContext<MockScenario>(emptyScenario)

export function MockScenarioProvider({ scenario, children }: { scenario: MockScenario; children: ReactNode }) {
  return <MockScenarioContext.Provider value={scenario}>{children}</MockScenarioContext.Provider>
}

export function useMockScenario(): MockScenario {
  return useContext(MockScenarioContext)
}

// --- Result synthesis --------------------------------------------------------

type QueryState = { loading?: boolean; error?: boolean }

/** Build a minimal-but-complete `UseQueryResult` from a value + optional state. */
function result<T>(data: T, state?: QueryState): UseQueryResult<T> {
  const isError = !!state?.error
  const isLoading = !!state?.loading
  const isSuccess = !isError && !isLoading
  return {
    data: isSuccess ? data : undefined,
    error: isError ? new Error('mock query error') : null,
    isError,
    isLoading,
    isPending: isLoading,
    isLoadingError: false,
    isRefetchError: false,
    isSuccess,
    isFetching: false,
    isStale: false,
    status: isError ? 'error' : isLoading ? 'pending' : 'success',
    fetchStatus: 'idle',
    refetch: async () => result(data, state),
    // The remaining UseQueryResult fields are unused by the components under test.
  } as unknown as UseQueryResult<T>
}

// --- Singular hooks (return UseQueryResult) ----------------------------------

export function useGlobalState() {
  const s = useMockScenario()
  return useMemo(() => result(s.globalState ?? { lastPeriodId: 0n }), [s])
}

export function usePeriods() {
  const s = useMockScenario()
  return useMemo(() => result(s.periods, { loading: s.flags?.periodsLoading, error: s.flags?.periodsError }), [s])
}

export function usePeriod(periodId: number) {
  const s = useMockScenario()
  return useMemo(
    () => result(s.periodDetail[periodId]?.period ?? null, { loading: s.flags?.periodLoading }),
    [s, periodId],
  )
}

export function usePeriodAppId(periodId: number) {
  const s = useMockScenario()
  return useMemo(() => result(s.periodDetail[periodId]?.appId ?? null), [s, periodId])
}

export function useAppEscrow(_address: string | null | undefined) {
  return useMemo(() => result<bigint | null>(null), [])
}

export function usePeriodBody(periodId: number) {
  const s = useMockScenario()
  return useMemo(() => result(s.periodDetail[periodId]?.body ?? null), [s, periodId])
}

export function useTopicBodies(periodId: number, _topicCount: number) {
  const s = useMockScenario()
  return useMemo(() => result(s.periodDetail[periodId]?.topicBodies ?? []), [s, periodId])
}

export function useCanVote(periodId: number, account?: string | null, _sender?: string | null) {
  const s = useMockScenario()
  return useMemo(
    () => result(account ? (s.canVote[pakey(periodId, account)] ?? undefined) : undefined),
    [s, periodId, account],
  )
}

export function useVoteRecord(periodId: number, account?: string | null) {
  const s = useMockScenario()
  return useMemo(
    () => result<GGovVoteRecord | null>(account ? (s.voteRecords[pakey(periodId, account)] ?? null) : null),
    [s, periodId, account],
  )
}

export function useVoters(periodId: number) {
  const s = useMockScenario()
  return useMemo(() => result(s.periodDetail[periodId]?.voters ?? []), [s, periodId])
}

export function useDelegation(account?: string | null) {
  const s = useMockScenario()
  return useMemo(() => {
    const delegatee = account ? (s.delegations.find(([d]) => d === account)?.[1] ?? '') : ''
    return result({ delegatee, exists: !!delegatee })
  }, [s, account])
}

export function useAllDelegations() {
  const s = useMockScenario()
  return useMemo(() => result(new Map(s.delegations)), [s])
}

export function useDelegatedToMe(account?: string | null) {
  const s = useMockScenario()
  return useMemo(
    () => result(account ? s.delegations.filter(([, d]) => d === account).map(([dl]) => dl) : []),
    [s, account],
  )
}

export function useCommittees() {
  const s = useMockScenario()
  return useMemo(() => result(Object.values(s.committees)), [s])
}

export function useCommittee(idBase64Url?: string) {
  const s = useMockScenario()
  return useMemo(() => result(idBase64Url ? (s.committees[idBase64Url] ?? null) : null), [s, idBase64Url])
}

export function useProducerRank(committeeIdBase64Url?: string, account?: string | null) {
  const s = useMockScenario()
  return useMemo(
    () =>
      result(
        committeeIdBase64Url && account ? (s.producerRanks?.[cakey(committeeIdBase64Url, account)] ?? null) : null,
      ),
    [s, committeeIdBase64Url, account],
  )
}

export function useMyVotes(_account?: string | null) {
  return useMemo(() => result<unknown[]>([]), [])
}

export function useCommitteeVotingPowers(_account?: string | null) {
  return useMemo(() => result<unknown[]>([]), [])
}

export function useCommitteeMembers(_idBase64Url?: string) {
  return useMemo(() => result<unknown[]>([]), [])
}

// --- Batched hooks (return plain Records, matching the real signatures) -------

export function useVoteStatuses(periodId: number, accounts: string[]): Record<string, boolean | undefined> {
  const s = useMockScenario()
  const out: Record<string, boolean | undefined> = {}
  for (const account of accounts) {
    const key = pakey(periodId, account)
    // An account the scenario never defines is unknown → `undefined` (matches the
    // real hook while the record is still loading). An explicit `null` record is a
    // resolved "eligible but didn't vote" → `false`.
    if (!(key in s.voteRecords)) {
      out[account] = undefined
      continue
    }
    const rec = s.voteRecords[key]
    out[account] = rec ? rec.topicVotes != null : false
  }
  return out
}

export function useVoteRecordMany(
  periodId: number,
  accounts: string[],
): Record<string, GGovVoteRecord | null | undefined> {
  const s = useMockScenario()
  const out: Record<string, GGovVoteRecord | null | undefined> = {}
  for (const account of accounts) out[account] = s.voteRecords[pakey(periodId, account)] ?? null
  return out
}

export function useCanVoteMany(
  periodId: number,
  accounts: string[],
  _sender?: string | null | Record<string, string | undefined>,
): Record<string, { canVote: boolean; votingPower: bigint } | undefined> {
  const s = useMockScenario()
  const out: Record<string, { canVote: boolean; votingPower: bigint } | undefined> = {}
  for (const account of accounts) out[account] = s.canVote[pakey(periodId, account)]
  return out
}

export function useGovVotingPowers(
  committeeIdBase64Url: string | undefined,
  accounts: string[],
): Record<string, number | undefined> {
  const s = useMockScenario()
  const out: Record<string, number | undefined> = {}
  for (const account of accounts) {
    out[account] = committeeIdBase64Url ? s.votingPowers[cakey(committeeIdBase64Url, account)] : undefined
  }
  return out
}

export function useBlockHeaders(rounds: number[]): Record<number, null> {
  const out: Record<number, null> = {}
  for (const round of rounds) out[round] = null
  return out
}
