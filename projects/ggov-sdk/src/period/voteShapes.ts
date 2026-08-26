import type { GGovVoteRecord as GGovVoteRecordFlat } from '../generated/GGovPeriodClient.js'

/**
 * The contracts store and submit a ballot FLAT: every topic's options concatenated in topic order,
 * shaped by the period's `topicOptionLengths`. That is an on-chain economy, not an API — a nested
 * `uint32[][]` costs an ARC-4 offset-table lookup plus a row decode/encode on *every* element
 * access, which is what dominated `vote()`'s opcode burn (a 22-topic frac vote fell from ~214k
 * opcodes to ~82k when the shape went flat).
 *
 * Off-chain that trade buys nothing and costs the shape: a flat array alone is not self-describing.
 * So the SDK is the boundary — it flattens ballots on the way in and re-rows them on the way out,
 * and callers keep the `[topic][option]` shape they think in.
 */

/** A vote record as the SDK hands it back: `topicVotes` re-rowed to `[topic][option]`. */
export type GGovVoteRecord = Omit<GGovVoteRecordFlat, 'topicVotes'> & { topicVotes: number[][] }

/** Concatenate a `[topic][option]` ballot into the flat shape the contracts take. */
export function flattenTopicVotes(topicVotes: number[][]): number[] {
  return topicVotes.flat()
}

/**
 * Re-row a flat tally into `[topic][option]` against a period's option counts
 * (`GGovPeriodShort.topicOptionLengths`).
 *
 * The reader methods here need none of this — `logVotingRecord` and `logPeriod` line their tallies
 * out per topic already. It is for the one shape that stays flat off chain: the ARC-28
 * `GGovVoteCast` event, whose `topicVotes` is the raw ballot as submitted.
 *
 * An empty tally stays empty whatever the shape. Otherwise a length mismatch throws rather than
 * returning a short or ragged result: a silently truncated ballot reads as a real vote.
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
