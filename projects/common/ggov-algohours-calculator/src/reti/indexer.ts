/** Indexer queries specific to the reti pipeline. */

import { indexerClient, scanTransactionRecords, withRetry } from '../indexer'
import { RETI_APP_ID } from './constants'
import { getRetiEventsFromTransactions } from './events'
import type { RetiEvent } from './types'

/** Scan ValidatorRegistry events in `[startRound, endRound)`, including inner-call logs. */
export async function scanRetiEvents(
  startRound: bigint,
  endRound: bigint,
  onBatch: (events: RetiEvent[]) => void,
): Promise<void> {
  await scanTransactionRecords(
    { applicationId: RETI_APP_ID },
    getRetiEventsFromTransactions,
    startRound,
    endRound,
    onBatch,
    'reti',
  )
}

// Byte offset of the uint32 epochRoundLength within the registry's 'v' box: the box holds
// ValidatorInfo whose first field is ValidatorConfig, all fixed-size fields before it.
const EPOCH_ROUND_LENGTH_OFFSET = 169

/**
 * Get each validator's epoch length in rounds from its registry config box.
 * The config is immutable after addValidator, so a live read holds for any round.
 */
export async function fetchEpochRoundLengths(validatorIds: Iterable<bigint>): Promise<Map<bigint, bigint>> {
  const lengths = new Map<bigint, bigint>()
  for (const validatorId of new Set(validatorIds)) {
    const name = Buffer.alloc(9)
    name.write('v')
    name.writeBigUInt64BE(validatorId, 1)
    const box = await withRetry(() => indexerClient.lookupApplicationBoxByIDandName(RETI_APP_ID, name).do())
    const epochRoundLength = Buffer.from(box.value).readUInt32BE(EPOCH_ROUND_LENGTH_OFFSET)
    lengths.set(validatorId, BigInt(epochRoundLength))
  }
  return lengths
}
