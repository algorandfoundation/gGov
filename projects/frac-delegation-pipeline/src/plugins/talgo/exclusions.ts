/**
 * Addresses that are not eligible for algoquarters.
 *
 * Scope: protocol escrow/reserve contracts only. Liquidity pool addresses are NOT
 * excluded — LP holdings are circulating supply held by real accounts and
 * must accrue algoquarters like any other holder.
 *
 * Their balances are still tracked during transfer replay and stored in
 * `SnapshotData.excluded`. This preserves every asset location and allows the
 * total supply to be verified.
 */

import { STALGO_APP_ADDRESS, TALGO_APP_ADDRESS } from './constants.ts'

/** Addresses that are NOT eligible for algoquarter calculation. */
export const EXCLUDED_ADDRESSES: ReadonlySet<string> = new Set([TALGO_APP_ADDRESS, STALGO_APP_ADDRESS])

/** Returns true if the address is excluded from algoquarter eligibility. */
export function isExcluded(address: string): boolean {
  return EXCLUDED_ADDRESSES.has(address)
}
