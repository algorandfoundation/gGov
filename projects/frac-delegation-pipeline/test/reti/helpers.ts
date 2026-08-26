/** Shared fixtures for the reti invariant unit tests. */

import type {
  EpochRewardUpdateEvent,
  PoolLedger,
  StakeAddedEvent,
  StakeRemovedEvent,
  StakerInfo,
} from '../../src/plugins/reti/types.ts'

export const POOL_A = 101n
export const POOL_B = 202n
export const VALIDATOR = 7n
export const EPOCH_LENGTH = 1_000n
export const EPOCH_LENGTHS = new Map([[VALIDATOR, EPOCH_LENGTH]])

const defaults = { round: 1, intraOffset: 0, validatorId: VALIDATOR, poolAppId: POOL_A }

export function makeStakeAdded(
  staker: string,
  amount: bigint,
  overrides: Partial<StakeAddedEvent> = {},
): StakeAddedEvent {
  return { type: 'stakeAdded', ...defaults, staker, amount, ...overrides }
}

export function makeStakeRemoved(
  staker: string,
  amount: bigint,
  overrides: Partial<StakeRemovedEvent> = {},
): StakeRemovedEvent {
  return { type: 'stakeRemoved', ...defaults, staker, amount, ...overrides }
}

export function makeEpochReward(
  algoAdded: bigint,
  overrides: Partial<EpochRewardUpdateEvent> = {},
): EpochRewardUpdateEvent {
  return { type: 'epochRewardUpdate', ...defaults, algoAdded, ...overrides }
}

export function poolOf(...stakers: [staker: string, balance: bigint, entryRound: number][]): Map<string, StakerInfo> {
  return new Map(stakers.map(([staker, balance, entryRound]) => [staker, { balance, entryRound }]))
}

export function poolsOf(
  ...pools: [poolAppId: bigint, stakers: [staker: string, balance: bigint, entryRound: number][]][]
): PoolLedger {
  return new Map(pools.map(([poolAppId, stakers]) => [poolAppId, poolOf(...stakers)]))
}
