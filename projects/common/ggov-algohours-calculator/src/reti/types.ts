/** Types for the reti pipeline. */

interface RetiEventBase {
  round: number
  /** Block timestamp at that round (unix seconds). */
  timestamp: number
  /** Position within the block — used as secondary sort key within the same round. */
  intraOffset: number
  /** Validator the pool belongs to — keys the epoch length used in reward splits. */
  validatorId: bigint
  /** StakingPool app holding the stake. */
  poolAppId: bigint
}

export interface StakeAddedEvent extends RetiEventBase {
  type: 'stakeAdded'
  staker: string
  amount: bigint
}

export interface StakeRemovedEvent extends RetiEventBase {
  type: 'stakeRemoved'
  staker: string
  amount: bigint
}

export interface EpochRewardUpdateEvent extends RetiEventBase {
  type: 'epochRewardUpdate'
  /** ALGO amount credited to the pool this epoch (post validator commission). */
  algoAdded: bigint
}

/** ARC-28 registry event affecting staker balances. */
export type RetiEvent = StakeAddedEvent | StakeRemovedEvent | EpochRewardUpdateEvent

/** A staker's position within one pool. */
export interface StakerInfo {
  /** Staked microALGO. */
  balance: bigint
  /** Stake-add round + 320 — reset on every add; determines the time-in-epoch reward weighting. */
  entryRound: number
}

/** Mutable ledger: poolAppId → staker → position. */
export type PoolLedger = Map<bigint, Map<string, StakerInfo>>

/** JSON-serialisable snapshot (bigint stored as decimal string). */
export interface RetiSnapshotData {
  /** Round at which balances were reconstructed, just before `round` transactions execute. */
  round: number
  /** Block timestamp at that round (unix seconds). */
  timestamp: number
  /** Per-pool staker positions at this round. All stakers are algohour-eligible. */
  pools: Record<string, Record<string, { balance: string; entryRound: number }>>
}
