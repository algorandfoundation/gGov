/**
 * Addresses that are not eligible for algoquarters.
 *
 * Their balances are still tracked during transfer replay and stored in
 * `SnapshotData.excluded`. This preserves every asset location and allows the
 * total supply to be verified.
 */

import { STALGO_APP_ADDRESS, TALGO_APP_ADDRESS } from './constants'

/** Addresses that are NOT eligible for algoquarter calculation. */
export const EXCLUDED_ADDRESSES: ReadonlySet<string> = new Set([TALGO_APP_ADDRESS, STALGO_APP_ADDRESS])

/** Returns true if the address is excluded from algoquarter eligibility. */
export function isExcluded(address: string): boolean {
  return EXCLUDED_ADDRESSES.has(address)
}
