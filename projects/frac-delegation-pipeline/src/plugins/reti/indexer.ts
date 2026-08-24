/** Indexer queries specific to the reti pipeline. */

import { type Indexer } from 'algosdk'

import { scanTransactionRecords, withRetry } from '../../aq/index.ts'
import { getRetiEventsFromTransactions } from './events.ts'
import type { RetiEvent } from './types.ts'

/** Scan ValidatorRegistry events in `[startRound, endRound)`, including inner-call logs. */
async function scanRetiEvents(
  indexer: Indexer,
  registryAppId: bigint,
  startRound: bigint,
  endRound: bigint,
  onBatch: (events: RetiEvent[]) => void,
): Promise<void> {
  await scanTransactionRecords(
    indexer,
    { applicationId: registryAppId },
    (txns) => getRetiEventsFromTransactions(txns, registryAppId),
    startRound,
    endRound,
    onBatch,
    'reti',
  )
}

/** Get all events in `[startRound, endRound)` plus the epoch lengths their reward splits need. */
export async function fetchRetiEvents(
  indexer: Indexer,
  registryAppId: bigint,
  startRound: bigint,
  endRound: bigint,
): Promise<{ events: RetiEvent[]; epochRoundLengths: Map<bigint, bigint> }> {
  const events: RetiEvent[] = []
  await scanRetiEvents(indexer, registryAppId, startRound, endRound, (batch) => {
    for (const event of batch) events.push(event)
  })
  const epochRoundLengths = await fetchEpochRoundLengths(
    indexer,
    registryAppId,
    events.map((event) => event.validatorId),
  )
  return { events, epochRoundLengths }
}

// Byte offset of the uint32 epochRoundLength within the registry's 'v' box: the box holds
// ValidatorInfo whose first field is ValidatorConfig, all fixed-size fields before it.
const EPOCH_ROUND_LENGTH_OFFSET = 169

/**
 * Get each validator's epoch length in rounds from its registry config box.
 * The config is immutable after addValidator, so a live read holds for any round.
 */
export async function fetchEpochRoundLengths(
  indexer: Indexer,
  registryAppId: bigint,
  validatorIds: Iterable<bigint>,
): Promise<Map<bigint, bigint>> {
  const lengths = new Map<bigint, bigint>()
  for (const validatorId of new Set(validatorIds)) {
    const name = Buffer.alloc(9)
    name.write('v')
    name.writeBigUInt64BE(validatorId, 1)
    const box = await withRetry(() => indexer.lookupApplicationBoxByIDandName(registryAppId, name).do())
    const epochRoundLength = Buffer.from(box.value).readUInt32BE(EPOCH_ROUND_LENGTH_OFFSET)
    lengths.set(validatorId, BigInt(epochRoundLength))
  }
  return lengths
}
