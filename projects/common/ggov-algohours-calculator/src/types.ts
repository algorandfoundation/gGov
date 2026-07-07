/**
 * Shared types for the algoquarter pipeline.
 */

/** A single ASA transfer event extracted from the indexer (top-level or inner txn). */
export interface AssetTransfer {
  /** Confirmed round (inherited from outer txn for inner txns). */
  round: number
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

export interface AccountWithAlgoQuarters {
  account: string
  /** AQ earned by the account (1 AQ = 1 ALGO staked for 3M rounds), floored integer as decimal string. */
  algoQuarters: string
}

export interface AlgoQuartersData {
  networkGenesisHash: string
  /** Protocol from which the algoquarters were calculated. */
  protocol: string
  periodStart: number
  periodEnd: number
  /** Liquid-token/ALGO rate used for the entire window (fixed-point decimal string with 12 decimal places). Absent for natively staked protocols. */
  rate?: string
  /** Number of eligible accounts. */
  totalAccounts: number
  /** Sum of all accounts' algoquarters (bigint as decimal string). */
  totalAlgoQuarters: string
  /**
   * Eligible accounts only. The unit is the eligibility cutoff: accounts
   * flooring below 1 AQ are omitted.
   */
  accounts: AccountWithAlgoQuarters[]
}
