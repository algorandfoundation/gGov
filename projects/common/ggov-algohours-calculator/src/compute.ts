/** Time-weighted algohour calculation for tALGO and stALGO balances. */

import { RATE_SCALER } from './constants/tinyman'
import { applyTransfer } from './ledger'
import type { AssetTransfer, BalanceMap, TaggedTransfer } from './types'

/**
 * Compute microALGO-hours over `[startTimestamp, endTimestamp)` using a fixed
 * tALGO/ALGO rate. The supplied balances are modified during transfer replay.
 *
 * Contributions retain their fixed-point precision and are rounded once per
 * account when converting accumulated microALGO-seconds to microALGO-hours.
 */
export function computeAlgoHours(
  balances: BalanceMap,
  transfers: TaggedTransfer[],
  startTimestamp: number,
  endTimestamp: number,
  tAlgoRate: bigint,
): Map<string, bigint> {
  const scaledMicroAlgoSeconds = new Map<string, bigint>()
  const lastAccruedTimestamp = new Map<string, number>()

  function accrueUntil(address: string, timestamp: number): void {
    const previousTimestamp = lastAccruedTimestamp.get(address)
    // First time this address appears in the window; start tracking it here
    if (previousTimestamp === undefined) {
      lastAccruedTimestamp.set(address, timestamp)
      return
    }

    // No time has elapsed since the last accrual, nothing to do
    const elapsedSeconds = timestamp - previousTimestamp
    if (elapsedSeconds === 0) return
    if (elapsedSeconds < 0) throw new Error('Non-monotonic timestamp')

    // Time has elapsed for the holder, accrue contribution
    const balance = balances.get(address)
    if (balance) {
      const scaledMicroAlgo = (balance.talgo + balance.stalgo) * tAlgoRate
      if (scaledMicroAlgo > 0n) {
        // Units: microALGO * seconds * RATE_SCALER
        const contribution = scaledMicroAlgo * BigInt(elapsedSeconds)
        scaledMicroAlgoSeconds.set(address, (scaledMicroAlgoSeconds.get(address) ?? 0n) + contribution)
      }
    }
    lastAccruedTimestamp.set(address, timestamp)
  }

  for (const [address, balance] of balances) {
    if (balance.talgo > 0n || balance.stalgo > 0n) {
      lastAccruedTimestamp.set(address, startTimestamp)
    }
  }

  for (const t of transfers) {
    accrueUntil(t.sender, t.timestamp)
    accrueUntil(t.receiver, t.timestamp)
    if (t.closeTo) accrueUntil(t.closeTo, t.timestamp)

    applyTransfer(balances, t, t.asset)
  }

  for (const address of lastAccruedTimestamp.keys()) {
    accrueUntil(address, endTimestamp)
  }

  // Remove rate scaling and convert seconds to hours
  const divisor = RATE_SCALER * 3_600n
  return new Map([...scaledMicroAlgoSeconds].map(([address, contribution]) => [address, contribution / divisor]))
}

/** Merge and chronologically sort tALGO and stALGO transfers. */
export function mergeAssetTransfers(
  tAlgoTransfers: AssetTransfer[],
  stAlgoTransfers: AssetTransfer[],
): TaggedTransfer[] {
  const transfers: TaggedTransfer[] = [
    ...tAlgoTransfers.map((transfer) => ({ ...transfer, asset: 'talgo' as const })),
    ...stAlgoTransfers.map((transfer) => ({ ...transfer, asset: 'stalgo' as const })),
  ]
  transfers.sort((a, b) => a.round - b.round || a.intraOffset - b.intraOffset)
  return transfers
}
