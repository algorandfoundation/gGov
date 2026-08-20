/** Indexer queries specific to the tALGO pipeline. */

import { type Indexer } from 'algosdk'

import { INDEXER_PAGE_SIZE, getAppEventsFromTransaction, withRetry } from '../../aq/index.ts'
import { TALGO_RATE_UPDATE_SELECTOR } from './constants.ts'

function decodeTAlgoRateUpdateLog(log: Uint8Array): bigint | null {
  if (log.length !== 12) return null
  if (!log.slice(0, 4).every((b, i) => b === TALGO_RATE_UPDATE_SELECTOR[i])) return null
  return Buffer.from(log.buffer, log.byteOffset, log.byteLength).readBigUInt64BE(4)
}

/**
 * Get the tALGO/ALGO rate from the first `rate_update(uint64)` ARC-28 event
 * the tALGO app logged in `[startRound, endRound)`, scanning forward.
 * Checks both outer and inner transaction logs.
 */
export async function fetchTAlgoRateInRange(
  indexer: Indexer,
  appId: bigint,
  startRound: bigint,
  endRound: bigint,
): Promise<bigint | null> {
  let nextToken: string | undefined

  do {
    let request = indexer
      .searchForTransactions()
      .applicationID(appId)
      .minRound(startRound)
      .maxRound(endRound - 1n)
      .limit(INDEXER_PAGE_SIZE)
    if (nextToken) request = request.nextToken(nextToken)

    const data = await withRetry(() => request.do())

    for (const txn of data.transactions ?? []) {
      const [rate] = getAppEventsFromTransaction(txn, appId, decodeTAlgoRateUpdateLog)
      if (rate !== undefined) return rate
    }

    nextToken = data.nextToken
    if (nextToken && data.transactions?.length === 0) break
  } while (nextToken)

  return null
}
