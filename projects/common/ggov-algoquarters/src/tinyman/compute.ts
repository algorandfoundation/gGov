/** Round-weighted algoquarter calculation for tALGO and stALGO balances. */

import { RATE_SCALER } from './constants'
import { applyTransfer } from './ledger'
import { MICROALGO_ROUNDS_PER_AQ } from '../utils/aq'
import type { AssetTransfer } from '../types'
import type { BalanceMap, TaggedTransfer } from './types'

/**
 * Compute integer AQ over rounds `[startRound, endRound)` using a fixed
 * tALGO/ALGO rate. The supplied balances are modified during transfer replay.
 *
 * Contributions retain their fixed-point precision and are floored once per
 * account when converting accumulated microALGO-rounds to AQ.
 */
export function computeAlgoQuarters(
  balances: BalanceMap,
  transfers: TaggedTransfer[],
  startRound: number,
  endRound: number,
  tAlgoRate: bigint,
): Map<string, bigint> {
  const scaledMicroAlgoRounds = new Map<string, bigint>()
  const lastAccruedRound = new Map<string, number>()

  function accrueUntil(address: string, round: number): void {
    const previousRound = lastAccruedRound.get(address)
    // First time this address appears in the window; start tracking it here
    if (previousRound === undefined) {
      lastAccruedRound.set(address, round)
      return
    }

    // No rounds have elapsed since the last accrual, nothing to do
    const elapsedRounds = round - previousRound
    if (elapsedRounds === 0) return
    if (elapsedRounds < 0) throw new Error('Non-monotonic round')

    // Rounds have elapsed for the holder, accrue contribution
    const balance = balances.get(address)
    if (balance) {
      const scaledMicroAlgo = (balance.talgo + balance.stalgo) * tAlgoRate
      if (scaledMicroAlgo > 0n) {
        // Units: microALGO * rounds * RATE_SCALER
        const contribution = scaledMicroAlgo * BigInt(elapsedRounds)
        scaledMicroAlgoRounds.set(address, (scaledMicroAlgoRounds.get(address) ?? 0n) + contribution)
      }
    }
    lastAccruedRound.set(address, round)
  }

  for (const [address, balance] of balances) {
    if (balance.talgo > 0n || balance.stalgo > 0n) {
      lastAccruedRound.set(address, startRound)
    }
  }

  for (const t of transfers) {
    accrueUntil(t.sender, t.round)
    accrueUntil(t.receiver, t.round)
    if (t.closeTo) accrueUntil(t.closeTo, t.round)

    applyTransfer(balances, t, t.asset)
  }

  for (const address of lastAccruedRound.keys()) {
    accrueUntil(address, endRound)
  }

  // Remove rate scaling and convert microALGO-rounds to AQ
  const divisor = RATE_SCALER * MICROALGO_ROUNDS_PER_AQ
  return new Map([...scaledMicroAlgoRounds].map(([address, contribution]) => [address, contribution / divisor]))
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
