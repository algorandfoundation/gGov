/** ARC-28 event decoding for the reti ValidatorRegistry. */

import { encodeAddress, type indexerModels } from 'algosdk'

import { getAppEventsFromTransaction } from '../../aq/index.ts'
import { EPOCH_REWARD_UPDATE_SELECTOR, STAKE_ADDED_SELECTOR, STAKE_REMOVED_SELECTOR } from './constants.ts'
import type { RetiEvent } from './types.ts'

function hasSelector(log: Uint8Array, selector: Buffer): boolean {
  return log.slice(0, 4).every((byte, i) => byte === selector[i])
}

function readUint64(log: Uint8Array, offset: number): bigint {
  return Buffer.from(log.buffer, log.byteOffset, log.byteLength).readBigUInt64BE(offset)
}

// Event payloads are fixed-size ABI tuples: selector(4) | validatorId u64 | poolNum u16 | poolAppId u64 | rest.
// Fields are decoded by byte offset; poolNum is not needed for algoquarters.
function decodeRetiEventLog(log: Uint8Array, round: number, intraOffset: number): RetiEvent | null {
  if (log.length < 22) return null
  const base = { round, intraOffset, validatorId: readUint64(log, 4), poolAppId: readUint64(log, 14) }

  if (log.length === 62 && hasSelector(log, STAKE_ADDED_SELECTOR)) {
    return { type: 'stakeAdded', ...base, staker: encodeAddress(log.slice(22, 54)), amount: readUint64(log, 54) }
  }
  if (log.length === 78 && hasSelector(log, STAKE_REMOVED_SELECTOR)) {
    return { type: 'stakeRemoved', ...base, staker: encodeAddress(log.slice(22, 54)), amount: readUint64(log, 54) }
  }
  if (log.length === 54 && hasSelector(log, EPOCH_REWARD_UPDATE_SELECTOR)) {
    return { type: 'epochRewardUpdate', ...base, algoAdded: readUint64(log, 38) }
  }
  return null
}

/**
 * Get reti events from indexer transactions, including nested inner transactions. Note
 * `stakeRemoved`/`epochRewardUpdate` are logged in inner pool to registry calls.
 * @param registryAppId ValidatorRegistry whose logs are decoded; logs of any other app are ignored
 */
export function getRetiEventsFromTransactions(txns: indexerModels.Transaction[], registryAppId: bigint): RetiEvent[] {
  const all: RetiEvent[] = []
  for (const txn of txns) {
    const round = Number(txn.confirmedRound ?? 0)
    const intraOffset = txn.intraRoundOffset ?? 0
    for (const event of getAppEventsFromTransaction(txn, registryAppId, (log) =>
      decodeRetiEventLog(log, round, intraOffset),
    )) {
      all.push(event)
    }
  }
  return all
}
