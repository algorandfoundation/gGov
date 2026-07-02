/**
 * Ledger replay engine.
 *
 * Applies ASA transfer events to a mutable BalanceMap.  Handles:
 *  - Regular transfers (sender → receiver)
 *  - Clawback transfers (clawback source → receiver; `indexer.ts` maps the clawback source to `sender`)
 *  - Self-transfers / opt-ins (sender == receiver, amount == 0)
 *  - Close-outs (remaining balance transferred to closeTo, sender zeroed)
 */

import type { AccountBalance, AssetTransfer, BalanceMap } from './types'

/** Get or init a balance entry for the given address. */
function getEntry(map: BalanceMap, address: string): AccountBalance {
  let bal = map.get(address)
  if (!bal) {
    bal = { talgo: 0n, stalgo: 0n }
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
export function applyTransfer(balances: BalanceMap, assetTransfer: AssetTransfer, key: 'talgo' | 'stalgo'): void {
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
export function totalSupply(balances: BalanceMap) {
  let talgo = 0n
  let stalgo = 0n
  for (const bal of balances.values()) {
    talgo += bal.talgo
    stalgo += bal.stalgo
  }
  return { talgo, stalgo }
}
