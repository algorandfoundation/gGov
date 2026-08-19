/** Types for the xALGO pipeline. */

import type { AssetTransfer } from 'ggov-algoquarters'

/** The two assets the replay tracks: xALGO itself, and the Folks pool's deposit receipt for it. */
export type XalgoAsset = 'xalgo' | 'fxalgo'

/** Tagged xALGO and fxALGO transfer. */
export interface TaggedTransfer extends AssetTransfer {
  asset: XalgoAsset
}

/** Per-account balance of tracked assets, in base units (6 dp). */
export interface AccountBalance {
  xalgo: bigint
  fxalgo: bigint
}

/** Mutable ledger: address → current balance. Keyed by the *holding* address (an escrow, not its owner). */
export type BalanceMap = Map<string, AccountBalance>

/** JSON-serialisable snapshot (bigint stored as decimal string). */
export interface SnapshotData {
  /** Round at which balances were reconstructed, just before `round` transactions execute. */
  round: number
  /**
   * Per-address balances at this round, for algoquarter-eligible holders. Raw custody: escrows
   * appear under their own address — owner resolution happens at attribution time, never here, so
   * the snapshot always reproduces chain state.
   */
  balances: Record<string, { xalgo: string; fxalgo: string }>
  /** Excluded addresses (xALGO reserve, the pool) and their balances at this round, for supply verification. */
  excluded: Record<string, { xalgo: string; fxalgo: string }>
}

/**
 * Who an fxALGO-holding address stands for. `escrow`: a Folks escrow, credited to `owner`. `self`:
 * anything else (wallet, DEX pool, other contract), credited to the address itself.
 */
export type Beneficiary = { kind: 'escrow'; owner: string; app: number; optInRound: number } | { kind: 'self' }

/** Resolved fxALGO holders: address → beneficiary. Immutable facts, so it only ever grows. */
export type BeneficiaryMap = Map<string, Beneficiary>

/** `snapshots/xalgo/beneficiaries.json`: the cache of every resolution so far, sorted by address. */
export interface BeneficiaryFile {
  entries: Array<{ address: string } & Beneficiary>
}

/** One rate observation from a consensus-app event: `rate = algo × RATE_SCALER / xalgo`. */
export interface XAlgoRateEvent {
  kind: 'ImmediateMint' | 'Burn' | 'ClaimDelayedMint'
  /** microALGO moved. */
  algo: bigint
  /** µxALGO minted or burned. */
  xalgo: bigint
}
