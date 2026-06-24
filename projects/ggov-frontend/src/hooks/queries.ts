import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import type { GGovPeriod, BodyJson, PeriodBodyJson, GGovVoteRecord, AccountWithVotes, GGovReaderSDK } from 'ggov-sdk'

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
  voters: (periodId: number) => ['voters', periodId] as const,
  appEscrow: (address: string) => ['appEscrow', address] as const,
  delegation: (account: string) => ['delegation', account] as const,
  allDelegations: ['allDelegations'] as const,
  delegatedToMe: (account: string) => ['delegatedToMe', account] as const,
  committees: ['committees'] as const,
  committee: (id: string) => ['committee', id] as const,
  myVotes: (account: string) => ['myVotes', account] as const,
  committeeVotingPowers: (account: string) => ['committeeVotingPowers', account] as const,
  committeeMembers: (id: string) => ['committeeMembers', id] as const,
  xgovVotingPower: (committeeId: string, account: string) => ['xgovVotingPower', committeeId, account] as const,
  producerRank: (committeeId: string, account: string) => ['producerRank', committeeId, account] as const,
  blockHeader: (round: number) => ['blockHeader', round] as const,
}

export function useGlobalState() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.globalState,
    queryFn: () => readerSDK.registry.getGlobalState(),
    staleTime: 60_000,
    meta: { surfaceError: true },
  })
}

export function usePeriods() {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periods,
    queryFn: () => fetchPeriods(readerSDK),
    // Mutations (add/edit/set-ready) invalidate this key, so a modest staleTime
    // just avoids refetching the list on every navigation back to it.
    staleTime: 60_000,
    meta: { surfaceError: true },
  })
}

export function usePeriod(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.period(periodId),
    queryFn: () => fetchPeriod(readerSDK, periodId),
    meta: { surfaceError: true },
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

/**
 * Resolve whether an address is an application escrow via the Escreg registry,
 * returning the owning app ID (or null when it isn't a registered escrow).
 * Whether an address is an app escrow is immutable, so this never goes stale; a
 * lookup failure resolves to null so the page just renders as a plain account.
 * (React Query forbids returning undefined from a queryFn, hence null.)
 */
export function useAppEscrow(address: string | null | undefined) {
  const { escregSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.appEscrow(address ?? ''),
    queryFn: async (): Promise<bigint | null> => {
      try {
        const result = await escregSDK.lookup({ addresses: [address!] })
        return result[address!] ?? null
      } catch {
        return null
      }
    },
    enabled: !!address,
    staleTime: Infinity,
  })
}

export function usePeriodBody(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.periodBody(periodId),
    queryFn: () => fetchPeriodBody(readerSDK, periodId),
    // Body is effectively immutable once uploaded; mutations that change it
    // (useUploadPeriodBodyMutation) invalidate this key, overriding staleTime.
    staleTime: 3_600_000,
  })
}

export function useTopicBodies(periodId: number, topicCount: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.topicBodies(periodId),
    queryFn: () => fetchTopicBodies(readerSDK, periodId, topicCount),
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

/** Accounts that cast a vote in a period (one `voteRecords` box per voter); its length is the voter count. */
export function useVoters(periodId: number) {
  const { readerSDK } = useGGovSDK()
  return useQuery<string[]>({
    queryKey: queryKeys.voters(periodId),
    queryFn: () => fetchVoters(readerSDK, periodId),
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
 * {@link useVoteStatuses}). Use when the `isDelegated` flag matters — e.g. to
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
      // When no sender is given the SDK defaults each voter's sender to itself, so seed under
      // that effective sender (the account) — matching how `useCanVote` keys the self case.
      accounts.forEach((account) => {
        queryClient.setQueryData(queryKeys.canVote(periodId, account, senderFor(account) ?? account), results.get(account))
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
    queryFn: () => readerSDK.registry.getAllDelegations(),
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

// --- Pure reader fetches, shared by the hooks below and the SSR route loaders ---
// (src/routes/_app/vote.period.$periodId, committees, committees.$committeeId).
// A loader seeds the query cache with these under the SAME query keys its page's
// hooks use, so the page renders server-side data immediately and never diverges
// from what the client would fetch.

// Ids/counts come from URL params (e.g. /vote/period/:periodId) and flow into
// BigInt(). Guard first so a malformed route (`/vote/period/abc` → Number() is
// NaN) fails with a clear error instead of a cryptic `BigInt(NaN)` RangeError —
// these helpers are shared by both the hooks and the SSR loaders.
function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

export function fetchPeriod(readerSDK: GGovReaderSDK, periodId: number): Promise<GGovPeriod> {
  assertNonNegativeInt(periodId, 'period id')
  return readerSDK.getPeriod(BigInt(periodId))
}

export function fetchPeriodBody(readerSDK: GGovReaderSDK, periodId: number): Promise<PeriodBodyJson | null> {
  assertNonNegativeInt(periodId, 'period id')
  return readerSDK.getPeriodBody(BigInt(periodId))
}

export function fetchVoters(readerSDK: GGovReaderSDK, periodId: number): Promise<string[]> {
  assertNonNegativeInt(periodId, 'period id')
  return readerSDK.getVoters(BigInt(periodId))
}

export function fetchTopicBodies(
  readerSDK: GGovReaderSDK,
  periodId: number,
  topicCount: number,
): Promise<(BodyJson | null)[]> {
  assertNonNegativeInt(periodId, 'period id')
  assertNonNegativeInt(topicCount, 'topic count')
  return Promise.all(
    Array.from({ length: topicCount }, (_, i) => readerSDK.getTopicBody(BigInt(periodId), BigInt(i))),
  )
}

export async function fetchPeriods(readerSDK: GGovReaderSDK): Promise<PeriodWithId[]> {
  const all = await readerSDK.getAllPeriods()
  return all.map(({ id, period, summary }) => ({ id: Number(id), period, ready: summary.ready }))
}

export async function fetchCommittees(readerSDK: GGovReaderSDK): Promise<CommitteeOption[]> {
  const ids = await readerSDK.registry.getCommitteeIds()
  // One batched simulate group instead of a serial metadata read per committee.
  const metas = await readerSDK.registry.getCommitteesMetadata(ids)
  const options: CommitteeOption[] = []
  for (let i = 0; i < ids.length; i++) {
    const meta = metas[i]
    if (!meta) continue
    options.push({
      id: ids[i],
      idBase64Url: toBase64Url(ids[i]),
      periodStart: meta.periodStart,
      periodEnd: meta.periodEnd,
      totalMembers: meta.totalMembers,
      totalVotes: meta.totalVotes,
    })
  }
  options.sort((a, b) => b.periodStart - a.periodStart)
  return options
}

export async function fetchCommittee(
  readerSDK: GGovReaderSDK,
  idBase64Url: string,
): Promise<CommitteeOption | null> {
  const bytes = fromBase64Url(idBase64Url)
  const meta = await readerSDK.registry.getCommitteeMetadata(bytes)
  if (!meta) return null
  return {
    id: bytes,
    idBase64Url,
    periodStart: meta.periodStart,
    periodEnd: meta.periodEnd,
    totalMembers: meta.totalMembers,
    totalVotes: meta.totalVotes,
  }
}

export function fetchCommitteeMembers(
  readerSDK: GGovReaderSDK,
  idBase64Url: string,
): Promise<AccountWithVotes[]> {
  return readerSDK.registry.getCommitteeXGovs(fromBase64Url(idBase64Url))
}

export function useCommittees() {
  const { readerSDK } = useGGovSDK()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.committees,
    queryFn: async (): Promise<CommitteeOption[]> => {
      const options = await fetchCommittees(readerSDK)
      // Seed the per-committee cache so useCommittee() reads warm data instead of
      // issuing its own metadata fetch.
      for (const option of options) {
        queryClient.setQueryData(queryKeys.committee(option.idBase64Url), option)
      }
      return options
    },
    // Committee metadata is effectively static historical data.
    staleTime: 600_000,
    meta: { surfaceError: true },
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
    queryFn: () => fetchCommittee(readerSDK, idBase64Url!),
    enabled: !!idBase64Url,
    // Committee metadata is effectively static historical data.
    staleTime: 600_000,
    meta: { surfaceError: true },
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
      const all = await readerSDK.getAllPeriods()
      // Resolve every period concurrently; per voted period, the body and topic
      // bodies have no inter-dependency so they fetch in parallel too.
      const entries = await Promise.all(
        all.map(async ({ id, period }): Promise<VoteEntry | null> => {
          try {
            const record = await readerSDK.getVotingRecord(id, account!)
            if (!record || record.topicVotes == null) return null
            const [body, topicBodies] = await Promise.all([
              readerSDK.getPeriodBody(id),
              Promise.all(
                Array.from({ length: period.topics.length }, (_, ti) =>
                  readerSDK.getTopicBody(id, BigInt(ti)).catch(() => null)
                )
              ),
            ])
            return { periodId: Number(id), period, record, body, topicBodies }
          } catch {
            return null /* no vote for this period */
          }
        })
      )
      return entries.filter((e): e is VoteEntry => e !== null)
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
      const ids = await readerSDK.registry.getCommitteeIds()
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

/** An account's standing among a committee's producers, ranked by votes (= blocks produced). */
export type ProducerRank = {
  /** 1-indexed position by votes (1 = most votes); accounts tied on votes share the same rank. */
  rank: number
  /** Total committee members ranked. */
  totalMembers: number
  /** The account's own votes. */
  votes: number
  /** Smallest p such that the account sits within the top p% of producers (1–100). */
  topPercentile: number
}

/**
 * Rank an account among a committee's producers by votes (= blocks produced),
 * derived from committee membership. Accounts tied on votes share a rank.
 * Returns null when the committee has no members or the account isn't one of them.
 */
function rankProducer(members: AccountWithVotes[], account: string): ProducerRank | null {
  if (members.length === 0) return null
  const mine = members.find((member) => member.account.toString() === account)
  if (!mine) return null
  // Standard competition ranking: position is the count of strictly-higher producers, plus one.
  const rank = members.filter((member) => member.votes > mine.votes).length + 1
  const topPercentile = Math.max(1, Math.min(100, Math.ceil((rank / members.length) * 100)))
  return { rank, totalMembers: members.length, votes: mine.votes, topPercentile }
}

/**
 * The connected account's producer rank within a committee (by votes = blocks
 * produced). Derives the standing from committee membership. `null` when the
 * account isn't a member.
 */
export function useProducerRank(committeeIdBase64Url: string | undefined, account: string | null | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.producerRank(committeeIdBase64Url ?? '', account ?? ''),
    queryFn: async (): Promise<ProducerRank | null> => {
      const members = await readerSDK.registry.getCommitteeXGovs(fromBase64Url(committeeIdBase64Url!))
      return rankProducer(members, account!)
    },
    enabled: !!committeeIdBase64Url && !!account,
    // Committee membership/votes are fixed once the committee exists.
    staleTime: 600_000,
  })
}

export function useCommitteeMembers(idBase64Url: string | undefined) {
  const { readerSDK } = useGGovSDK()
  return useQuery({
    queryKey: queryKeys.committeeMembers(idBase64Url ?? ''),
    queryFn: () => fetchCommitteeMembers(readerSDK, idBase64Url!),
    enabled: !!idBase64Url,
    // A committee's membership is fixed once the committee exists.
    staleTime: 600_000,
    meta: { surfaceError: true },
  })
}

/** Header-only details for a single block round, as surfaced in the UI. */
export interface BlockHeaderInfo {
  round: number
  /** Block timestamp in unix seconds. */
  timestamp: number
}

/**
 * Header-only block lookups for several rounds at once (one algod `block` call
 * each, header-only). Backs the committee detail's start/end block panel. Each
 * round resolves independently and a failed lookup yields `null` rather than
 * throwing, so the panel can degrade to "round known, fields unavailable".
 * Value per round: the header info, `null` if the lookup failed, or `undefined`
 * while still loading.
 */
export function useBlockHeaders(rounds: number[]): Record<number, BlockHeaderInfo | null | undefined> {
  const { readerSDK } = useGGovSDK()
  const results = useQueries({
    queries: rounds.map((round) => ({
      queryKey: queryKeys.blockHeader(round),
      queryFn: async (): Promise<BlockHeaderInfo | null> => {
        try {
          // Header-only: skip the payset/certificate — we only need round metadata.
          const res = await readerSDK.algorand.client.algod.block(round).headerOnly(true).do()
          const header = res.block.header
          return {
            round: Number(header.round),
            timestamp: Number(header.timestamp),
          }
        } catch {
          // Archival/header data may be unavailable (e.g. non-archival node) — degrade gracefully.
          return null
        }
      },
      enabled: round > 0,
      // Block headers are immutable once the round is final.
      staleTime: Infinity,
    })),
  })
  const out: Record<number, BlockHeaderInfo | null | undefined> = {}
  rounds.forEach((round, i) => {
    out[round] = results[i]?.isSuccess ? results[i].data : undefined
  })
  return out
}
