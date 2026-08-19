/** Indexer queries specific to the xALGO pipeline: the xALGO/ALGO rate events. */

import { type Indexer } from 'algosdk'

import { INDEXER_PAGE_SIZE, getAppEventsFromTransaction, withRetry } from 'ggov-algoquarters'
import {
  BURN_LOG_LENGTH,
  BURN_SELECTOR,
  CLAIM_DELAYED_MINT_LOG_LENGTH,
  CLAIM_DELAYED_MINT_SELECTOR,
  IMMEDIATE_MINT_LOG_LENGTH,
  IMMEDIATE_MINT_SELECTOR,
  RATE_SCALER,
} from './constants.ts'
import type { XAlgoRateEvent } from './types.ts'

const hasSelector = (log: Uint8Array, selector: Uint8Array): boolean =>
  log.length >= 4 && selector.every((byte, i) => log[i] === byte)

const readUint64 = (log: Uint8Array, offset: number): bigint =>
  Buffer.from(log.buffer, log.byteOffset, log.byteLength).readBigUInt64BE(offset)

/**
 * Decode one consensus-app log into a rate observation, or null for anything else. Byte layouts
 * (verified on mainnet rounds 64215436 and 64215568, and against the contract source):
 *
 *   ImmediateMint     4 sel | 32 sender | 32 receiver | 8 algo | 8 xalgo          = 84 bytes
 *   Burn              4 sel | 32 sender | 8 xalgo | 8 algo                        = 52 bytes  (xALGO first!)
 *   ClaimDelayedMint  4 sel | 36 box name | 32 minter | 32 receiver | 8 algo | 8 xalgo = 120 bytes
 */
export function decodeXAlgoRateEventLog(log: Uint8Array): XAlgoRateEvent | null {
  if (hasSelector(log, IMMEDIATE_MINT_SELECTOR) && log.length === IMMEDIATE_MINT_LOG_LENGTH) {
    return { kind: 'ImmediateMint', algo: readUint64(log, 68), xalgo: readUint64(log, 76) }
  }
  if (hasSelector(log, BURN_SELECTOR) && log.length === BURN_LOG_LENGTH) {
    return { kind: 'Burn', xalgo: readUint64(log, 36), algo: readUint64(log, 44) }
  }
  if (hasSelector(log, CLAIM_DELAYED_MINT_SELECTOR) && log.length === CLAIM_DELAYED_MINT_LOG_LENGTH) {
    return { kind: 'ClaimDelayedMint', algo: readUint64(log, 104), xalgo: readUint64(log, 112) }
  }
  return null
}

/** The xALGO/ALGO rate an event observed, scaled by `RATE_SCALER` (floored). */
export function rateOfEvent(event: XAlgoRateEvent): bigint {
  if (event.xalgo <= 0n) throw new Error(`xalgo: ${event.kind} event with no xALGO amount`)
  return (event.algo * RATE_SCALER) / event.xalgo
}

/** The window's rate, and the event it was read from (for the log line and the premium caveat). */
export interface XAlgoRateObservation {
  /** xALGO/ALGO rate scaled by `RATE_SCALER`. */
  rate: bigint
  event: XAlgoRateEvent
  round: number
}

/**
 * Get the xALGO/ALGO rate from the first rate event (`Burn`, `ClaimDelayedMint` or `ImmediateMint`)
 * the consensus app logged in `[startRound, endRound)`, scanning forward. Checks both outer and
 * inner transaction logs (ultrastake mints are inner calls from the StakeAndDeposit router).
 *
 * One rate per window, like tALGO: the drift over a window (~0.4%/month) is symmetric across all
 * holders and does not change relative shares. `Burn` and `ClaimDelayedMint` are exact
 * (`algoBalance / xAlgoCirculatingSupply`); `ImmediateMint` embeds the app's `premium`
 * (0 today, capped at 1%), so when the first event is a mint and the live `premium` global is
 * non-zero the caller should warn.
 *
 * @returns null when the window holds no rate event (~7.8k app calls per 1M rounds, so never in practice)
 * @throws when the observed rate is outside `[1, 2)` ALGO per xALGO — a wrong app id or a decoder
 *   regression, not a real rate
 */
export async function fetchXAlgoRateInRange(
  indexer: Indexer,
  appId: bigint,
  startRound: bigint,
  endRound: bigint,
): Promise<XAlgoRateObservation | null> {
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
      const [event] = getAppEventsFromTransaction(txn, appId, decodeXAlgoRateEventLog)
      if (event === undefined) continue
      const rate = rateOfEvent(event)
      if (rate < RATE_SCALER || rate >= 2n * RATE_SCALER) {
        throw new Error(
          `xalgo: ${event.kind} at round ${txn.confirmedRound} implies a rate of ${rate} / ${RATE_SCALER} ALGO per xALGO — wrong app id or decoder?`,
        )
      }
      return { rate, event, round: Number(txn.confirmedRound ?? 0) }
    }

    nextToken = data.nextToken
    if (nextToken && data.transactions?.length === 0) break
  } while (nextToken)

  return null
}
