import type {
  FracEscrowVotes as FracEscrowVotesFlat,
  FracPeriodVoteCache as FracPeriodVoteCacheFlat,
  FracVotingRecord as FracVotingRecordFlat,
} from '../generated/FracDelegationInstanceClient.js'
import type { FracAccountVotingRecord as FracAccountVotingRecordFlat } from '../generated/FracDelegationRegistryClient.js'

/**
 * The contracts store and submit a ballot FLAT: every topic's options concatenated in topic order,
 * shaped by the period's `topicOptionLengths`. That is an on-chain economy, not an API — a nested
 * `uint32[][]` costs an ARC-4 offset-table lookup plus a row decode/encode on *every* element
 * access, which is what dominated `vote()`'s opcode burn (a 22-topic, 6-escrow frac vote fell from
 * ~214k opcodes to ~82k when the shape went flat, bringing xALGO back under the pooled budget).
 *
 * Off-chain that trade buys nothing and costs the shape: a flat array alone is not self-describing.
 * So the SDK is the boundary — it flattens ballots on the way in and re-rows every tally it reads
 * back against the period's option counts, and callers keep the `[topic][option]` shape they think
 * in. These are the types it hands back; the generated flat structs stay internal to the readers.
 */

/** A pool's aggregate tallies for a period, re-rowed to `[topic][option]`. */
export type FracPeriodVoteCache = Omit<FracPeriodVoteCacheFlat, 'internal' | 'ggovTotals'> & {
  internal: number[][]
  ggovTotals: number[][]
}

/** One escrow's external gGov votes for a period, re-rowed to `[topic][option]`. */
export type FracEscrowVotes = Omit<FracEscrowVotesFlat, 'votes'> & { votes: number[][] }

/** An account's internal ballot on one pool, re-rowed to `[topic][option]`. */
export type FracVotingRecord = Omit<FracVotingRecordFlat, 'topicVotes'> & { topicVotes: number[][] }

/** An account's internal ballot on one pool, tagged with that pool's identity. */
export type FracAccountVotingRecord = Omit<FracAccountVotingRecordFlat, 'topicVotes'> & { topicVotes: number[][] }

/** Concatenate a `[topic][option]` ballot into the flat shape the contracts take. */
export function flattenTopicVotes(topicVotes: number[][]): number[] {
  return topicVotes.flat()
}

/**
 * Re-row a flat tally into `[topic][option]` against a period's option counts.
 *
 * An empty tally stays empty whatever the shape: every reader here uses "no cells" as its
 * "has not voted" / "no box" sentinel, and that answer must survive re-rowing.
 *
 * Otherwise a length mismatch throws rather than returning a short or ragged result — a silently
 * truncated ballot reads as a real vote, and every caller here is rendering one.
 */
export function toTopicRows(flat: number[], topicOptionLengths: number[]): number[][] {
  if (flat.length === 0) return []
  const rows: number[][] = []
  let cell = 0
  for (const width of topicOptionLengths) {
    rows.push(flat.slice(cell, cell + width))
    cell += width
  }
  if (cell !== flat.length) {
    throw new Error(`Vote shape mismatch: ${flat.length} cells for topic option counts [${topicOptionLengths}]`)
  }
  return rows
}
