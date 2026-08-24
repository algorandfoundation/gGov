/**
 * Addresses that are not eligible for algoquarters.
 *
 * - The xALGO app address is the reserve: un-minted supply, and where burns land.
 * - The Folks xALGO pool address is excluded for two reasons at once: its xALGO is *redistributed*
 *   to fxALGO holders by the attribution (crediting it too would double count), and its fxALGO is
 *   the un-minted fxALGO reserve (so it is also left out of the pro-rata denominator).
 *
 * Liquidity pools and other contracts are NOT excluded — their holdings are circulating supply held
 * by real accounts and accrue algoquarters like any other holder (same policy as tALGO). They
 * simply cannot vote, so their share folds into Abstain.
 *
 * Excluded balances are still tracked during replay and stored in `SnapshotData.excluded`, so total
 * supply can always be verified.
 */

import { XALGO_APP_ADDRESS, XALGO_POOL_ADDRESS } from './constants.ts'

/** Addresses that are NOT eligible for algoquarter calculation. */
export const EXCLUDED_ADDRESSES: ReadonlySet<string> = new Set([XALGO_APP_ADDRESS, XALGO_POOL_ADDRESS])

/** Returns true if the address is excluded from algoquarter eligibility. */
export function isExcluded(address: string): boolean {
  return EXCLUDED_ADDRESSES.has(address)
}
