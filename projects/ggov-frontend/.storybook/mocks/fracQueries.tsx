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
import { cakey, type MockPooledPosition } from './scenarios'

// Public types — single source of truth in the real module.
export type {
  PooledPosition,
  PooledPositions,
  PooledBallotPosition,
  PooledBallot,
  CommitteePool,
  CommitteePools,
} from '../../src/hooks/fracQueries'

import type {
  PooledPosition,
  PooledPositions,
  PooledBallotPosition,
  PooledBallot,
  CommitteePool,
  CommitteePools,
} from '../../src/hooks/fracQueries'

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
      // The real hook drops entries with no stake (`userAq > 0 && totalAq > 0`),
      // so a fixture pool the account merely *appears* in isn't a position of
      // theirs — the pools index would otherwise mark every pool "yours".
      const positions = pooled[cakey(idBase64Url, account)]?.filter((p) => p.userAq > 0 && p.totalAq > 0)
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

/**
 * Committee composition — the aggregate the committee page shows, derived from
 * the same `pooled` fixture. The fixture is keyed by (committee, account), so a
 * pool's committee-wide power is summed over whichever accounts a story defines
 * for it; `members` counts those accounts. Enough to exercise the section's
 * stats, bar and legend without a registry.
 */
export function useCommitteePools(committeeIdBase64Url: string | undefined): CommitteePools {
  const s = useMockScenario()
  const pooled = s.pooled ?? {}
  const isLoading = !!s.flags?.pooledLoading

  const byInstance = new Map<number, CommitteePool>()
  if (committeeIdBase64Url && !isLoading) {
    const prefix = `${committeeIdBase64Url}:`
    for (const [key, positions] of Object.entries(pooled)) {
      if (!key.startsWith(prefix)) continue
      for (const position of positions) {
        const pool = byInstance.get(position.instanceNumId)
        if (pool) {
          if (position.poolMembers === undefined) pool.members += 1
        } else {
          byInstance.set(position.instanceNumId, {
            instanceNumId: position.instanceNumId,
            // The fixture has no separate numeric committee id; instances are
            // read one committee at a time, so the pool's own id serves as one.
            committeeNumId: position.instanceNumId,
            name: position.instanceName,
            members: position.poolMembers ?? 1,
            // Window-scoped stakers and the roster are one number in the fixture:
            // it has no notion of an account that joined after the window closed.
            stakers: position.poolMembers ?? 1,
            votes: position.poolVotes,
            aq: position.totalAq,
          })
        }
      }
    }
  }

  const pools = [...byInstance.values()].sort((a, b) => b.votes - a.votes)
  return {
    pools,
    pooledVotes: pools.reduce((sum, pool) => sum + pool.votes, 0),
    participants: pools.reduce((sum, pool) => sum + pool.members, 0),
    isLoading,
    isError: false,
    fracEnabled: true,
  }
}

/**
 * Per-pool turnout, in AlgoQuarters. Sums the `userAq` of every fixture position
 * carrying a `voteRecord` — the same records the ballot mock reads — so a story
 * that marks accounts as voted gets a matching turnout figure.
 */
export function useCommitteePoolVotedAq(
  pools: CommitteePool[],
  periodId: number | undefined,
): { byInstance: Record<number, number>; isLoading: boolean } {
  const s = useMockScenario()
  const isLoading = !!s.flags?.pooledLoading

  const byInstance: Record<number, number> = {}
  if (periodId !== undefined && !isLoading) {
    for (const pool of pools) {
      const entries = [...positionsByAccount(s.pooled ?? {}, pool.instanceNumId)]
      // No entries at all means the pool never synced the period — absent, not zero.
      if (entries.length === 0) continue
      const declared = entries.find(([, position]) => position.poolVotedAq !== undefined)?.[1].poolVotedAq
      byInstance[pool.instanceNumId] =
        declared ?? entries.reduce((sum, [, position]) => sum + (position.voteRecord ? position.userAq : 0), 0)
    }
  }
  return { byInstance, isLoading }
}

/** Fixture positions in one pool, keyed by the account half of the fixture key. */
function positionsByAccount(
  pooled: Record<string, MockPooledPosition[]>,
  instanceNumId: number,
): Map<string, MockPooledPosition> {
  const out = new Map<string, MockPooledPosition>()
  for (const [key, positions] of Object.entries(pooled)) {
    const account = key.slice(key.indexOf(':') + 1)
    for (const position of positions) {
      if (position.instanceNumId === instanceNumId) out.set(account, position)
    }
  }
  return out
}

/** Present for completeness; the pages only use {@link usePooledPositions}. */
export function useFracAccount(account: string | null | undefined) {
  const { isPoolMember } = usePooledPositions(account, [])
  return { data: isPoolMember ? { accountId: 1, instanceNumIds: [1] } : null, isPending: false }
}
