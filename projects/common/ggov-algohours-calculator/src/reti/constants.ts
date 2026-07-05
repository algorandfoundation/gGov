/**
 * Réti open pooling — mainnet constants.
 * https://github.com/algorandfoundation/reti
 */

import { createHash } from 'node:crypto'

// Protocol identifier, goes on algohours output files
export const PROTOCOL = 'reti'

// ValidatorRegistry app. Staked ALGO lives in per-pool StakingPool apps, but every balance change is logged on the
// registry as an ARC-28 event, so it is the single scan target for the whole protocol.
// Creation: https://mainnet-idx.4160.nodely.dev/v2/transactions/H2LX3OQZA3EAFU67MN7CDTGP46MSJWCPBK5JB526CJMUTIEAKMPQ
export const RETI_APP_ID = 2714516089n
export const RETI_APP_CREATION_ROUND = 46_518_891n

function eventSelector(signature: string): Buffer {
  return createHash('sha512-256').update(signature).digest().subarray(0, 4)
}

// Event signatures from the reti repo ValidatorRegistry ARC-4 app spec.
// Fields: (validatorId, poolNum, poolAppId, staker, amountStaked)
export const STAKE_ADDED_SELECTOR = eventSelector('retiOP_stakeAdded(uint64,uint16,uint64,address,uint64)')
// Fields: (validatorId, poolNum, poolAppId, staker, amountUnstaked, rewardTokensReceived, rewardTokenAssetId)
export const STAKE_REMOVED_SELECTOR = eventSelector(
  'retiOP_stakeRemoved(uint64,uint16,uint64,address,uint64,uint64,uint64)',
)
// Fields: (validatorId, poolNum, poolAppId, validatorCommission, saturatedBurnToFeeSink, algoAdded, rewardTokenHeldBack)
export const EPOCH_REWARD_UPDATE_SELECTOR = eventSelector(
  'retiOP_epochRewardUpdate(uint64,uint16,uint64,uint64,uint64,uint64,uint64)',
)

// Pools enforce that a staker's remaining balance is either 0 or ≥ the pool's min entry
// stake (never below 1 ALGO), so a removal leaving less than this must be a full unstake.
export const MIN_ENTRY_STAKE = 1_000_000n

// Consensus reads online stake from 320 rounds back, so added stake only starts earning
// rewards after this delay; pools mirror it by setting entryRound to the add round + 320.
export const STAKING_BLOCK_DELAY = 320
