/** Types for the tinyman (tALGO/stALGO) pipeline. */

import type { AssetTransfer } from '../types'

/** Tagged tALGO and stALGO transfer. */
export interface TaggedTransfer extends AssetTransfer {
  asset: 'talgo' | 'stalgo'
}

/** Per-account balance of tracked assets. */
export interface AccountBalance {
  talgo: bigint
  stalgo: bigint
}

/** Mutable ledger: address → current balance. */
export type BalanceMap = Map<string, AccountBalance>

/** JSON-serialisable snapshot (bigint stored as decimal string). */
export interface SnapshotData {
  /** Round at which balances were reconstructed, just before `round` transactions execute. */
  round: number
  /** Block timestamp at that round (unix seconds). */
  timestamp: number
  /** Per-address balances at this round, for algohour-eligible holders (users, not apps). */
  balances: Record<string, { talgo: string; stalgo: string }>
  /** Excluded addresses (app escrows/LPs, reserve) and their balances at this round. Useful for supply verification. */
  excluded: Record<string, { talgo: string; stalgo: string }>
}
