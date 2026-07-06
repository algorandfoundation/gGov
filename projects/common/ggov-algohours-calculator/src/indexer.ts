/** Algorand Indexer queries used by the algohour pipeline. */

import { type indexerModels } from 'algosdk'

import { SCAN_WINDOW, createIndexerClient } from './config'
import type { AssetTransfer } from './types'

// Process-wide client, configured from INDEXER_SERVER/INDEXER_TOKEN at module load.
// To mix endpoints in one process, refactor the query functions to accept a client.
export const indexerClient = createIndexerClient()

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Retryable: rate limits, server errors, and network-level failures (queries are idempotent GETs)
      if (
        !/429|500|502|503|504|fetch failed|timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message) ||
        retry >= MAX_RETRIES
      )
        throw error
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
// ARC-28 event extraction
// ---------------------------------------------------------------------------

/**
 * Recursively decode ARC-28 logs emitted by `appId` from a transaction and its inner
 * transactions. Log payload decoding stays with the caller; a decoder returns null for
 * logs it does not recognize.
 */
export function getAppEventsFromTransaction<T>(
  txn: indexerModels.Transaction,
  appId: bigint,
  decodeEventLog: (log: Uint8Array) => T | null,
): T[] {
  const results: T[] = []

  if (txn.txType === 'appl' && txn.applicationTransaction?.applicationId === appId) {
    for (const log of txn.logs ?? []) {
      const event = decodeEventLog(log)
      if (event !== null) results.push(event)
    }
  }

  for (const inner of txn.innerTxns ?? []) {
    for (const event of getAppEventsFromTransaction(inner, appId, decodeEventLog)) {
      results.push(event)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Transaction scanning
// ---------------------------------------------------------------------------

export const INDEXER_PAGE_SIZE = 1_000

/**
 * Scan indexer transactions in `[startRound, endRound)` using fixed-size windows,
 * decoding each page into records and passing them to `onBatch` to avoid storing
 * everything in memory.
 *
 * Replay depends on ascending (round, intra) order. The Indexer returns results
 * that way by construction; the scan verifies it per record and throws if the order is ever altered.
 */
export async function scanTransactionRecords<T extends { round: number; intraOffset: number }>(
  filter: { assetId?: bigint; applicationId?: bigint },
  decodeTransactions: (txns: indexerModels.Transaction[]) => T[],
  startRound: bigint,
  endRound: bigint,
  onBatch: (records: T[]) => void,
  tag: string,
): Promise<void> {
  let windowStart = startRound
  let lastRound = -1
  let lastIntraOffset = -1

  while (windowStart < endRound) {
    const nextEnd = windowStart + SCAN_WINDOW
    const windowEnd = nextEnd > endRound ? endRound : nextEnd

    console.log(`  [${tag}] scanning rounds [${windowStart}, ${windowEnd - 1n}]…`)
    let recordCount = 0
    let nextToken: string | undefined

    do {
      let request = indexerClient
        .searchForTransactions()
        .minRound(windowStart)
        .maxRound(windowEnd - 1n)
        .limit(INDEXER_PAGE_SIZE)
      if (filter.assetId !== undefined) request = request.assetID(filter.assetId)
      if (filter.applicationId !== undefined) request = request.applicationID(filter.applicationId)
      if (nextToken) request = request.nextToken(nextToken)

      const data = await withRetry(() => request.do())
      const records = decodeTransactions(data.transactions ?? [])
      for (const record of records) {
        if (record.round < lastRound || (record.round === lastRound && record.intraOffset < lastIntraOffset)) {
          throw new Error(
            `Indexer returned transactions out of order: (${record.round}, ${record.intraOffset}) after (${lastRound}, ${lastIntraOffset})`,
          )
        }
        lastRound = record.round
        lastIntraOffset = record.intraOffset
      }
      if (records.length > 0) {
        onBatch(records)
        recordCount += records.length
      }

      nextToken = data.nextToken
      if (nextToken && data.transactions?.length === 0) {
        console.log('[indexer] received empty page with next-token — stopping pagination')
        break
      }
    } while (nextToken)

    console.log(`  [${tag}] ${recordCount} records found`)
    windowStart = windowEnd
  }
}

/** Scan ASA transfers in `[startRound, endRound)`, including nested inner transactions. */
export async function scanAssetTransfers(
  assetId: bigint,
  startRound: bigint,
  endRound: bigint,
  onBatch: (transfers: AssetTransfer[]) => void,
  label?: string,
): Promise<void> {
  await scanTransactionRecords(
    { assetId },
    (txns) => getAssetTransfersFromTransactions(txns, assetId),
    startRound,
    endRound,
    onBatch,
    label ?? `ASA ${assetId}`,
  )
}
