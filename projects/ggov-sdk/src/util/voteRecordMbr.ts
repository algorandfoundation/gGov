/**
 * Box MBR for one vote record — the per-voter cost the *registry* ultimately funds.
 *
 * A vote writes its record on the child app, not on the registry: `GGovPeriod.voteRecords`
 * (`BoxMap<Account, GGovVoteRecord>`, prefix 'v') and `FracDelegationInstance.votingRecords`
 * (`BoxMap<FracPeriodAccountKey, FracVotingRecord>`, prefix 'r'). Neither call carries a payment, so
 * when the child runs dry its `checkNeedMBR` pulls a fixed `mbrTopUp` chunk off the registry. Sizing
 * a registry's funding therefore starts here.
 *
 * Both record types are ARC-4 `(bool, uint32[][])` and differ only in key width, so this takes the
 * key length as an argument rather than existing twice. See `GGOV_VOTE_RECORD_KEY_LENGTH` below and
 * `FRAC_VOTING_RECORD_KEY_LENGTH` in frac-delegation-sdk.
 */

/** AVM per-box flat MBR component. */
const BOX_FLAT_MICROALGOS = 2_500n

/** AVM per-byte MBR component, charged over name + value length. */
const BOX_PER_BYTE_MICROALGOS = 400n

/**
 * Key length of `GGovPeriod.voteRecords`: the 1-byte 'v' prefix plus a 32-byte account.
 */
export const GGOV_VOTE_RECORD_KEY_LENGTH = 33

/**
 * Encoded byte length of an ARC-4 `(bool, uint32[][])` vote record whose `[topic][option]` shape has
 * `optionCounts[t]` options in topic `t`.
 *
 * ```
 * head   1 bool + 2-byte offset to the dynamic tail        = 3
 * tail   2-byte outer length (topic count)                 = 2
 *        per topic: 2-byte element offset
 *                 + 2-byte inner length
 *                 + 4 bytes per uint32 option              = 4 + 4 * options
 * ```
 *
 * The per-topic term is the same `4 + 4 * numOptions` that `GGovPeriod.setReady` sums when it
 * rejects a ballot whose `GGovVoteCast` event would overflow the 1024-byte log budget — that
 * contract is the cross-check for this arithmetic.
 *
 * A vote must submit a row for every topic, so the box is written at full size on the first vote and
 * never grows. There is no partial-record case to account for.
 */
export function voteRecordValueLength(optionCounts: readonly number[]): number {
  let length = 5
  for (const options of optionCounts) length += 4 + 4 * options
  return length
}

/**
 * Minimum balance (µAlgo) the child app account locks up for one voter's record.
 *
 * @param keyLength box name length — {@link GGOV_VOTE_RECORD_KEY_LENGTH} for a gGov period,
 *   `FRAC_VOTING_RECORD_KEY_LENGTH` for a frac instance
 * @param optionCounts options per topic, parallel to the period's topics
 */
export function voteRecordBoxMbr(keyLength: number, optionCounts: readonly number[]): bigint {
  return BOX_FLAT_MICROALGOS + BOX_PER_BYTE_MICROALGOS * BigInt(keyLength + voteRecordValueLength(optionCounts))
}
