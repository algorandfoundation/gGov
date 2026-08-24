/**
 * Ledger replay engine.
 *
 * Applies ASA transfer events to a mutable BalanceMap, for xALGO and fxALGO alike. Handles:
 *  - Regular transfers (sender → receiver)
 *  - Clawback transfers (neither asset has a clawback, but the shared scanner maps a clawback
 *    source to `sender` anyway, so they would replay correctly)
 *  - Self-transfers / opt-ins (sender == receiver, amount == 0)
 *  - Close-outs (remaining balance transferred to closeTo, sender zeroed)
 *
 * Same logic as `talgo/ledger.ts`, over the `{ xalgo, fxalgo }` balance shape. A pool deposit is two
 * of these in one instant: xALGO holder → pool, then fxALGO pool (reserve) → holder.
 */

import type { AssetTransfer } from '../../aq/index.ts'
import type { AccountBalance, BalanceMap, XalgoAsset } from './types.ts'

/** Get or init a balance entry for the given address. */
function getEntry(map: BalanceMap, address: string): AccountBalance {
  let bal = map.get(address)
  if (!bal) {
    bal = { xalgo: 0n, fxalgo: 0n }
    map.set(address, bal)
  }
  return bal
}

/**
 * Apply a single ASA transfer to the ledger.
 *
 * @param balances  Mutable balance map (modified in-place).
 * @param assetTransfer  The transfer to apply.
 * @param key  Which asset field to update.
 */
export function applyTransfer(balances: BalanceMap, assetTransfer: AssetTransfer, key: XalgoAsset): void {
  const { sender, receiver, amount, closeTo, closeAmount } = assetTransfer

  // Opt-in: sender == receiver, amount == 0, no close-out.
  if (sender === receiver && amount === 0n && !closeTo) {
    getEntry(balances, sender)
    return
  }

  const senderBal = getEntry(balances, sender)
  const receiverBal = getEntry(balances, receiver)

  if (sender !== receiver) {
    senderBal[key] -= amount
    receiverBal[key] += amount
  }

  if (closeTo) {
    const closeToBal = getEntry(balances, closeTo)
    const computedRemainder = senderBal[key]
    if (computedRemainder < 0n) {
      throw new Error(`Negative ${key} close-out for ${sender} at round ${assetTransfer.round}`)
    }
    if (closeAmount !== undefined && closeAmount !== computedRemainder) {
      throw new Error(`Close-out ${key} mismatch for ${sender} at round ${assetTransfer.round}`)
    }

    const remainder = closeAmount ?? computedRemainder
    closeToBal[key] += remainder
    senderBal[key] = 0n
  }

  if (senderBal[key] < 0n) {
    throw new Error(`Negative ${key} balance for ${sender} at round ${assetTransfer.round}`)
  }
}

/** Sum of all balances across every address. Useful for supply verification. */
export function totalSupply(balances: BalanceMap): { xalgo: bigint; fxalgo: bigint } {
  let xalgo = 0n
  let fxalgo = 0n
  for (const bal of balances.values()) {
    xalgo += bal.xalgo
    fxalgo += bal.fxalgo
  }
  return { xalgo, fxalgo }
}
