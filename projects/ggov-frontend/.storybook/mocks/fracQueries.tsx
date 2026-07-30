/**
 * Storybook mock for `@/hooks/fracQueries`.
 *
 * Aliased in `.storybook/main.ts`. The real hooks reach the frac registry over the
 * network through a lazily-imported SDK, so without this the pooled surfaces could
 * only ever be seen in their empty state. Positions come from
 * {@link MockScenario.pooled}, keyed `${committeeB64}:${account}` — the same
 * `cakey` the voting-power fixtures use.
 *
 * Same context-sharing trick as the `queries` mock: the scenario context lives in
 * that module and is imported by relative path here, so both aliases resolve to
 * one shared provider instance.
 */
import { useMockScenario } from './queries'
import { cakey } from './scenarios'

// Public types — single source of truth in the real module.
export type { PooledPosition, PooledPositions, PooledBallotPosition, PooledBallot } from '../../src/hooks/fracQueries'

import type { PooledPosition, PooledPositions, PooledBallotPosition, PooledBallot } from '../../src/hooks/fracQueries'

export function usePooledPositions(
  account: string | null | undefined,
  committeeIdsBase64Url: string[],
): PooledPositions {
  const s = useMockScenario()
  const pooled = s.pooled ?? {}

  // Pool membership is account-scoped, not committee-scoped: an account with any
  // entry in the fixture is a member, even for a committee the story doesn't list.
  // The real hook learns this from one registry read, before amounts resolve.
  const suffix = `:${account ?? ''}`
  const isPoolMember = !!account && Object.keys(pooled).some((key) => key.endsWith(suffix))

  // `pooledLoading` models "we know they're in a pool, the amounts aren't in yet".
  const isLoading = !!s.flags?.pooledLoading

  const byCommittee: Record<string, PooledPosition[]> = {}
  if (account && !isLoading) {
    for (const idBase64Url of committeeIdsBase64Url) {
      const positions = pooled[cakey(idBase64Url, account)]
      if (positions?.length) byCommittee[idBase64Url] = positions
    }
  }

  return { byCommittee, isPoolMember, isLoading, fracEnabled: true }
}

/**
 * Ballot-side mock. Reads the same `pooled` fixture, but resolves it against the
 * accounts the page can act for and folds in the ballot-only state
 * ({@link MockPooledPosition}'s `canVote` / `voteRecord` / `votedDirectly` /
 * `poolNotReady`) that decides each row's status.
 *
 * `senderOf` comes straight from the page, so the "is this position mine or a
 * delegator's" split is driven by the same mapping the real hook uses.
 */
export function usePooledBallot({
  committeeIdBase64Url,
  voters,
  senderOf,
  isActive,
}: {
  periodId: number
  committeeIdBase64Url?: string
  voters: string[]
  senderOf: Record<string, string>
  isActive: boolean
}): PooledBallot {
  const s = useMockScenario()
  const pooled = s.pooled ?? {}
  const isLoading = !!s.flags?.pooledLoading

  const positions: PooledBallotPosition[] = []
  if (committeeIdBase64Url && !isLoading) {
    for (const owner of voters) {
      for (const p of pooled[cakey(committeeIdBase64Url, owner)] ?? []) {
        const sender = senderOf[owner] ?? owner
        const canVote = p.canVote ?? true
        const votedDirectly = p.votedDirectly ?? false
        positions.push({
          instanceNumId: p.instanceNumId,
          instanceName: p.instanceName,
          userAq: p.userAq,
          totalAq: p.totalAq,
          sharePct: p.sharePct,
          poolVotes: p.poolVotes,
          votes: p.votes,
          id: `${p.instanceNumId}:${owner}`,
          owner,
          ownerIsSelf: sender === owner,
          sender,
          canVote,
          // The contract returns the member's AlgoQuarters as the ballot weight.
          aqWeight: BigInt(p.userAq),
          hasVoted: !!p.voteRecord,
          topicVotes: p.voteRecord,
          votedDirectly,
          poolNotReady: p.poolNotReady ?? (isActive && !canVote && !(sender !== owner && votedDirectly)),
        })
      }
    }
  }

  const byId: Record<string, PooledBallotPosition> = {}
  for (const position of positions) byId[position.id] = position
  return { positions, byId, isLoading, fracEnabled: true }
}

/** Present for completeness; the pages only use {@link usePooledPositions}. */
export function useFracAccount(account: string | null | undefined) {
  const { isPoolMember } = usePooledPositions(account, [])
  return { data: isPoolMember ? { accountId: 1, instanceNumIds: [1] } : null, isPending: false }
}
