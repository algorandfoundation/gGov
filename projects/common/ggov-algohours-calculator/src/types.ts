/**
 * Shared types for the algohour pipeline.
 */

/** A single ASA transfer event extracted from the indexer (top-level or inner txn). */
export interface AssetTransfer {
  /** Confirmed round (inherited from outer txn for inner txns). */
  round: number
  /** Block timestamp in unix seconds (inherited from outer txn). */
  timestamp: number
  /** Position within the block — used as secondary sort key within the same round. */
  intraOffset: number
  /** Sender address (base32). */
  sender: string
  /** Receiver address (base32). */
  receiver: string
  /** Amount transferred (asset base units). */
  amount: bigint
  /** Address receiving the closed-out remainder. */
  closeTo?: string
  /** Amount transferred to closeTo (the sender's remaining balance after the regular transfer). */
  closeAmount?: bigint
}

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

// ---------------------------------------------------------------------------
// JSON-serialisable output types (bigint stored as decimal string)
// ---------------------------------------------------------------------------

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

export interface AccountWithAlgoHours {
  account: string
  /** Algohours earned by the account (microALGO × hours). */
  algoHours: string
}

export interface AlgoHoursData {
  networkGenesisHash: string
  /** Protocol the algohours were calculated from. */
  protocol: string
  periodStart: number
  periodEnd: number
  periodStartTime: number
  periodEndTime: number
  /** tALGO/ALGO rate used for the entire window (fixed-point decimal string with 12 decimal places). */
  rate: string
  /** Number of eligible accounts. */
  totalAccounts: number
  /** Sum of all accounts' algohours (microALGO × hours, bigint as decimal string). */
  totalAlgoHours: string
  /** Eligible holders only, from `SnapshotData.balances`. */
  accounts: AccountWithAlgoHours[]
}
