/**
 * Ledger replay engine.
 *
 * Staker balances live in each pool's `stakers` box, which is only readable at the current
 * round. The ledger rebuilds past box state from the registry's event stream instead:
 * `applyRetiEvent`, applied over all events since the registry's creation, replicates the
 * balance-relevant slice of every pool's box (see `StakerInfo`). Handles:
 *  - Stake adds (new or existing staker; every add resets the staker's entryRound)
 *  - Stake removals, reconciling full unstakes against split residues
 *  - Epoch rewards, split with the staking pool contract's own algorithm (see splitReward)
 */

import { STAKING_BLOCK_DELAY, MIN_ENTRY_STAKE } from './constants'
import type { PoolLedger, RetiEvent, StakerInfo } from './types'

// Max accepted residue when zeroing a full unstake. Residues accumulate from seeding the
// reward split with the credited total instead of the contract's pre-dust reward (a few
// microALGO per epoch at most); anything larger means a replay bug.
const RESIDUE_TOLERANCE = 10_000n // 0.01 ALGO

/** Get or init the staker map for the given pool. */
function getPool(pools: PoolLedger, poolAppId: bigint): Map<string, StakerInfo> {
  let pool = pools.get(poolAppId)
  if (!pool) {
    pool = new Map()
    pools.set(poolAppId, pool)
  }
  return pool
}

/**
 * Split an epoch reward across a pool's stakers, replicating `epochBalanceUpdate` in the
 * staking pool contract: stakers who joined during the epoch get a share proportional to
 * balance × fraction-of-epoch-in-pool, and what they leave on the table goes to full-epoch
 * stakers by their share of the full-epoch stake — or stays in the pool account for the
 * next epoch when nobody has been in for a full epoch.
 *
 * The event only carries the credited total (`algoAdded`), not the pre-split reward the
 * contract divided, so the pre-split reward is recovered by binary search: the credited
 * total is monotone in it, and the contract's own value hits `algoAdded` exactly.
 *
 * @param pool  The pool's stakers state just before the payout is applied.
 * @param algoAdded  Credited total carried by the `retiOP_epochRewardUpdate` event.
 * @param eventRound  Round the payout executed in — fixes which epoch it settles.
 * @param epochRoundLength  The pool validator's epoch length in rounds.
 * @returns Per-staker credited microALGO, summing exactly to `algoAdded`.
 */
export function splitReward(
  pool: Map<string, StakerInfo>,
  algoAdded: bigint,
  eventRound: number,
  epochRoundLength: bigint,
): Map<string, bigint> {
  let totalStaked = 0n
  for (const { balance } of pool.values()) totalStaked += balance
  if (totalStaked === 0n) throw new Error('Epoch reward for a pool with no stake')

  // Differentiate between full-epoch stakers and partials; save full-epoch total stake
  const thisEpochBegin = BigInt(eventRound) - (BigInt(eventRound) % epochRoundLength)
  const partials: Array<{ staker: string; balance: bigint; timePercentage: bigint }> = []
  const fulls: Array<{ staker: string; balance: bigint }> = []
  let fullEpochStake = 0n
  for (const [staker, { balance, entryRound }] of pool) {
    if (balance === 0n) continue
    const timeInPool = thisEpochBegin - BigInt(entryRound)
    if (timeInPool >= epochRoundLength) {
      fulls.push({ staker, balance })
      fullEpochStake += balance
    } else if (timeInPool > 0n) {
      // Fraction of the epoch in pool, scaled to 0–1000 (34.7% → 347)
      partials.push({ staker, balance, timePercentage: (timeInPool * 1000n) / epochRoundLength })
    }
  }

  function computeShares(reward: bigint): { shares: Map<string, bigint>; credited: bigint } {
    const shares = new Map<string, bigint>()
    let credited = 0n
    for (const { staker, balance, timePercentage } of partials) {
      const share = (balance * reward * timePercentage) / (totalStaked * 1000n)
      shares.set(staker, share)
      credited += share
    }
    if (fullEpochStake > 0n) {
      const remaining = reward - credited
      for (const { staker, balance } of fulls) {
        const share = (balance * remaining) / fullEpochStake
        shares.set(staker, share)
        credited += share
      }
    }
    return { shares, credited }
  }

  // Recover the contract's pre-split reward: the smallest reward whose credited total reaches algoAdded
  // 1. Find an upper bound for the binary search interval; lower bound is trivially algoAdded
  let upperBound = algoAdded
  for (let i = 0; computeShares(upperBound).credited < algoAdded; i++) {
    if (i >= 64) throw new Error(`No reward can credit ${algoAdded} at round ${eventRound} — replay is off`)
    upperBound *= 2n
  }
  let lowerBound = algoAdded
  // 2. Perform binary search to find reward such that computeShares(reward).credited === algoAdded
  while (lowerBound < upperBound) {
    const mid = (lowerBound + upperBound) / 2n
    if (computeShares(mid).credited < algoAdded) lowerBound = mid + 1n
    else upperBound = mid
  }

  // Credited totals move in steps of up to 1 microALGO per staker, so the exact value can be
  // skipped over; absorb a mismatch up to that bound on the largest share, throw beyond it.
  const { shares, credited } = computeShares(lowerBound)
  const mismatch = credited - algoAdded
  if (mismatch !== 0n) {
    if (mismatch > BigInt(shares.size) || mismatch < 0n) {
      throw new Error(
        `Epoch reward at round ${eventRound} credits ${credited} but the chain credited ${algoAdded} — replay is off`,
      )
    }
    let largest: string | undefined
    for (const [staker, share] of shares) {
      if (largest !== undefined) {
        const best = shares.get(largest)!
        if (share < best || (share === best && staker > largest)) continue
      }
      largest = staker
    }
    shares.set(largest!, shares.get(largest!)! - mismatch)
  }
  return shares
}

/**
 * Apply a single registry event to the ledger.
 *
 * @param pools  Mutable pool ledger (modified in-place).
 * @param event  The event to apply.
 * @param epochRoundLengths  Epoch length per validator id (see fetchEpochRoundLengths).
 * @returns The per-staker balance deltas that were applied.
 */
export function applyRetiEvent(
  pools: PoolLedger,
  event: RetiEvent,
  epochRoundLengths: Map<bigint, bigint>,
): Array<{ staker: string; delta: bigint }> {
  const pool = getPool(pools, event.poolAppId)

  switch (event.type) {
    case 'stakeAdded': {
      const balance = pool.get(event.staker)?.balance ?? 0n
      pool.set(event.staker, {
        balance: balance + event.amount,
        entryRound: event.round + STAKING_BLOCK_DELAY,
      })
      return [{ staker: event.staker, delta: event.amount }]
    }

    case 'stakeRemoved': {
      const info = pool.get(event.staker)
      if (info === undefined) {
        throw new Error(`Stake removed for unknown staker ${event.staker} at round ${event.round}`)
      }
      const remaining = info.balance - event.amount
      if (remaining >= MIN_ENTRY_STAKE) {
        // Partial unstake; entryRound is not reset
        pool.set(event.staker, { ...info, balance: remaining })
        return [{ staker: event.staker, delta: -event.amount }]
      }
      // The contract forbids balances in (0, minEntryStake), so this is a full unstake;
      // the residue is our reward-split error for this staker and must stay tiny.
      const residue = remaining < 0n ? -remaining : remaining
      if (residue > RESIDUE_TOLERANCE) {
        throw new Error(
          `Full unstake of ${event.amount} by ${event.staker} at round ${event.round} ` +
            `leaves a residue of ${residue} beyond tolerance — replay is off, investigate.`,
        )
      }
      pool.delete(event.staker)
      return [{ staker: event.staker, delta: -info.balance }]
    }

    case 'epochRewardUpdate': {
      if (event.algoAdded === 0n) return []
      const epochRoundLength = epochRoundLengths.get(event.validatorId)
      if (epochRoundLength === undefined) {
        throw new Error(`No epoch length for validator ${event.validatorId} — fetch it before replay`)
      }
      const deltas: Array<{ staker: string; delta: bigint }> = []
      for (const [staker, share] of splitReward(pool, event.algoAdded, event.round, epochRoundLength)) {
        if (share === 0n) continue
        const info = pool.get(staker)!
        pool.set(staker, { ...info, balance: info.balance + share })
        deltas.push({ staker, delta: share })
      }
      return deltas
    }
  }
}

/** Sum of all staked balances across every pool. Useful for supply verification. */
export function totalStaked(pools: PoolLedger): bigint {
  let total = 0n
  for (const pool of pools.values()) {
    for (const { balance } of pool.values()) total += balance
  }
  return total
}
