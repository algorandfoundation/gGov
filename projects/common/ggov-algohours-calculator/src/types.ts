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

// ---------------------------------------------------------------------------
// JSON-serialisable output types (bigint stored as decimal string)
// ---------------------------------------------------------------------------

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
  /** Liquid-token/ALGO rate used for the entire window (fixed-point decimal string with 12 decimal places). Absent for natively staked protocols. */
  rate?: string
  /** Number of eligible accounts. */
  totalAccounts: number
  /** Sum of all accounts' algohours (microALGO × hours, bigint as decimal string). */
  totalAlgoHours: string
  accounts: AccountWithAlgoHours[]
}
