/** Algorand Indexer queries used by the algohour pipeline. */

import { type indexerModels } from 'algosdk'

import { SCAN_WINDOW, createIndexerClient } from './config'
import { TALGO_APP_ID, TALGO_RATE_UPDATE_SELECTOR } from './constants/tinyman'
import type { AssetTransfer } from './types'

// Process-wide client, configured from INDEXER_SERVER/INDEXER_TOKEN at module load.
// To mix endpoints in one process, refactor the query functions to accept a client.
const indexerClient = createIndexerClient()

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/429|500|502|503|504/.test(message) || retry >= MAX_RETRIES) throw error
      const delay = Math.min(2_000 * 2 ** retry, 30_000)
      console.log(`  [indexer] ${message.slice(0, 100)} — retry ${retry + 1}/${MAX_RETRIES} in ${delay}ms…`)
      await sleep(delay)
    }
  }
}

// ---------------------------------------------------------------------------
// Asset and block lookups
// ---------------------------------------------------------------------------

/** Base64 genesis hash of the network the Indexer serves, from the block-1 header. */
export async function fetchGenesisHash(): Promise<string> {
  const data = await withRetry(() => indexerClient.lookupBlock(1n).do())
  if (!data.genesisHash) throw new Error('Indexer returned no genesis hash for block 1')
  return Buffer.from(data.genesisHash).toString('base64')
}

/** Get the creation round and total supply for `assetId`. */
export async function fetchAssetMetadata(assetId: bigint) {
  const data = await withRetry(() => indexerClient.lookupAssetByID(assetId).do())
  const creationRound = data.asset.createdAtRound
  if (creationRound === undefined) {
    throw new Error(`Missing creation round for asset ${assetId}`)
  }
  return {
    creationRound,
    totalSupply: data.asset.params.total,
  }
}

/** Get the Unix timestamp in seconds for the block at `round`. */
export async function fetchBlockTimestamp(round: bigint): Promise<number> {
  const data = await withRetry(() => indexerClient.lookupBlock(round).do())
  return data.timestamp
}

// ---------------------------------------------------------------------------
// Asset transfer extraction
// ---------------------------------------------------------------------------

/**
 * Recursively get ASA transfers from a transaction to include inner transactions.
 * Inner transactions inherit the outer transaction's round metadata.
 */
function getAssetTransfersFromTransaction(
  txn: indexerModels.Transaction,
  assetId: bigint,
  round: number,
  timestamp: number,
  intraOffset: number,
): AssetTransfer[] {
  const results: AssetTransfer[] = []

  if (txn.txType === 'axfer') {
    const x = txn.assetTransferTransaction
    if (x && x.assetId === assetId) {
      results.push({
        round,
        timestamp,
        intraOffset,
        // x.sender is (asnd): the clawback source for clawback txns.
        // Falls back to txn.sender for regular transfers.
        sender: x.sender ?? txn.sender,
        receiver: x.receiver,
        amount: x.amount,
        closeTo: x.closeTo,
        closeAmount: x.closeAmount,
      })
    }
  }

  for (const inner of txn.innerTxns ?? []) {
    for (const transfer of getAssetTransfersFromTransaction(inner, assetId, round, timestamp, intraOffset)) {
      results.push(transfer)
    }
  }

  return results
}

/** Get ASA transfers from indexer transactions, including nested inner transactions. */
function getAssetTransfersFromTransactions(txns: indexerModels.Transaction[], assetId: bigint): AssetTransfer[] {
  const all: AssetTransfer[] = []
  for (const txn of txns) {
    const round = Number(txn.confirmedRound ?? 0)
    const timestamp = txn.roundTime ?? 0
    const intraOffset = txn.intraRoundOffset ?? 0
    for (const transfer of getAssetTransfersFromTransaction(txn, assetId, round, timestamp, intraOffset)) {
      all.push(transfer)
    }
  }
  return all
}

// ---------------------------------------------------------------------------
// Asset transfer scanning
// ---------------------------------------------------------------------------

const INDEXER_PAGE_SIZE = 1_000

/**
 * Scan ASA transfers in `[startRound, endRound)` using fixed-size windows.
 * Pass each page results to `onBatch` to avoid storing all transfers in memory.
 *
 * Replay depends on ascending (round, intra) order. The Indexer returns results
 * that way by construction; the scan verifies it per transfer and throws if the order is ever altered.
 */
export async function scanAssetTransfers(
  assetId: bigint,
  startRound: bigint,
  endRound: bigint,
  onBatch: (transfers: AssetTransfer[]) => void,
  label?: string,
): Promise<void> {
  const tag = label ?? `ASA ${assetId}`
  let windowStart = startRound
  let lastRound = -1
  let lastIntraOffset = -1

  while (windowStart < endRound) {
    const nextEnd = windowStart + SCAN_WINDOW
    const windowEnd = nextEnd > endRound ? endRound : nextEnd

    console.log(`  [${tag}] scanning rounds [${windowStart}, ${windowEnd - 1n}]…`)
    let transferCount = 0
    let nextToken: string | undefined

    do {
      let request = indexerClient
        .searchForTransactions()
        .assetID(assetId)
        .minRound(windowStart)
        .maxRound(windowEnd - 1n)
        .limit(INDEXER_PAGE_SIZE)
      if (nextToken) request = request.nextToken(nextToken)

      const data = await withRetry(() => request.do())
      const transfers = getAssetTransfersFromTransactions(data.transactions ?? [], assetId)
      for (const transfer of transfers) {
        if (transfer.round < lastRound || (transfer.round === lastRound && transfer.intraOffset < lastIntraOffset)) {
          throw new Error(
            `Indexer returned transfers out of order: (${transfer.round}, ${transfer.intraOffset}) after (${lastRound}, ${lastIntraOffset})`,
          )
        }
        lastRound = transfer.round
        lastIntraOffset = transfer.intraOffset
      }
      if (transfers.length > 0) {
        onBatch(transfers)
        transferCount += transfers.length
      }

      nextToken = data.nextToken
      if (nextToken && data.transactions?.length === 0) {
        console.log('[indexer] received empty page with next-token — stopping pagination')
        break
      }
    } while (nextToken)

    console.log(`  [${tag}] ${transferCount} transfers found`)
    windowStart = windowEnd
  }
}

// ---------------------------------------------------------------------------
// tALGO/ALGO rate lookup
// ---------------------------------------------------------------------------

function decodeTAlgoRateUpdateLog(log: Uint8Array): bigint | null {
  if (log.length !== 12) return null
  if (!log.slice(0, 4).every((b, i) => b === TALGO_RATE_UPDATE_SELECTOR[i])) return null
  return Buffer.from(log.buffer, log.byteOffset, log.byteLength).readBigUInt64BE(4)
}

function findTAlgoRateInTransaction(txn: indexerModels.Transaction): bigint | null {
  for (const log of txn.logs ?? []) {
    const rate = decodeTAlgoRateUpdateLog(log)
    if (rate !== null) return rate
  }
  for (const inner of txn.innerTxns ?? []) {
    const rate = findTAlgoRateInTransaction(inner)
    if (rate !== null) return rate
  }
  return null
}

/**
 * Get the tALGO/ALGO rate from the first `rate_update(uint64)` ARC-28
 * event found in `[startRound, endRound)`, scanning forward.
 * Checks both outer and inner transaction logs.
 */
export async function fetchTAlgoRateInRange(startRound: bigint, endRound: bigint): Promise<bigint | null> {
  let nextToken: string | undefined

  do {
    let request = indexerClient
      .searchForTransactions()
      .applicationID(TALGO_APP_ID)
      .minRound(startRound)
      .maxRound(endRound - 1n)
      .limit(INDEXER_PAGE_SIZE)
    if (nextToken) request = request.nextToken(nextToken)

    const data = await withRetry(() => request.do())

    for (const txn of data.transactions ?? []) {
      const rate = findTAlgoRateInTransaction(txn)
      if (rate !== null) return rate
    }

    nextToken = data.nextToken
    if (nextToken && data.transactions?.length === 0) break
  } while (nextToken)

  return null
}
