/** Round-weighted algoquarter accrual for reti staked balances. */

import { MICROALGO_ROUNDS_PER_AQ } from '../../aq/index.ts'
import { applyRetiEvent } from './ledger.ts'
import type { PoolLedger, RetiEvent } from './types.ts'

/** Accrued microALGO-rounds, keyed the way stake is held: poolAppId → staker → contribution. */
export type MicroAlgoRoundsByPool = Map<bigint, Map<string, bigint>>

/**
 * Accrue every staker's microALGO-rounds over `[startRound, endRound)`, per pool.
 *
 * Staked ALGO is native, so no rate is involved. `pools` is mutated as the events replay, exactly
 * as `applyRetiEvent` would on its own.
 *
 * Accrual is keyed by **(poolAppId, staker)** and returned *unfloored*, because the pool a stake
 * sits in decides which frac instance it backs: an instance covers one validator's pools that are
 * in the committee, and stake in that validator's other pools backs none of the votes it casts.
 * Flooring to whole AQ is therefore the caller's decision, over the pool set it cares about —
 * see `sumMicroAlgoRounds` and `toAlgoQuarters`.
 *
 * Summing per-pool contributions and flooring once reproduces the aggregate-then-floor result
 * exactly: accrual is linear in balance, so `∫ Σ balance = Σ ∫ balance`, and only the single
 * flooring at the end is lossy.
 */
export function computeRetiMicroAlgoRounds(
  pools: PoolLedger,
  events: RetiEvent[],
  epochRoundLengths: Map<bigint, bigint>,
  startRound: number,
  endRound: number,
): MicroAlgoRoundsByPool {
  const microAlgoRounds: MicroAlgoRoundsByPool = new Map()
  const lastAccruedRound = new Map<bigint, Map<string, number>>()

  /** Balances are read straight off the ledger, so the accrual can never drift from the replay. */
  function balanceOf(poolAppId: bigint, staker: string): bigint {
    return pools.get(poolAppId)?.get(staker)?.balance ?? 0n
  }

  function accrueUntil(poolAppId: bigint, staker: string, round: number): void {
    let poolRounds = lastAccruedRound.get(poolAppId)
    if (!poolRounds) lastAccruedRound.set(poolAppId, (poolRounds = new Map()))

    // First time this staker appears in this pool within the window; start tracking it here
    const previousRound = poolRounds.get(staker)
    if (previousRound === undefined) {
      poolRounds.set(staker, round)
      return
    }

    // No rounds have elapsed since the last accrual, nothing to do
    const elapsedRounds = round - previousRound
    if (elapsedRounds === 0) return
    if (elapsedRounds < 0) throw new Error('Non-monotonic round')

    // Rounds have elapsed for the staker, accrue contribution
    const balance = balanceOf(poolAppId, staker)
    if (balance > 0n) {
      let poolContributions = microAlgoRounds.get(poolAppId)
      if (!poolContributions) microAlgoRounds.set(poolAppId, (poolContributions = new Map()))
      poolContributions.set(staker, (poolContributions.get(staker) ?? 0n) + balance * BigInt(elapsedRounds))
    }
    poolRounds.set(staker, round)
  }

  // Everyone holding stake when the window opens starts accruing at its first round
  for (const [poolAppId, stakers] of pools) {
    for (const [staker, { balance }] of stakers) {
      if (balance > 0n) accrueUntil(poolAppId, staker, startRound)
    }
  }

  for (const event of events) {
    // Accrue everyone the event touches before mutating balances. An epoch payout credits the
    // whole pool, so every staker in it has to be settled up to the payout round first.
    if (event.type === 'epochRewardUpdate') {
      for (const staker of pools.get(event.poolAppId)?.keys() ?? []) accrueUntil(event.poolAppId, staker, event.round)
    } else {
      accrueUntil(event.poolAppId, event.staker, event.round)
    }

    applyRetiEvent(pools, event, epochRoundLengths)
  }

  // Settle every tracked position up to the end of the window
  for (const [poolAppId, poolRounds] of lastAccruedRound) {
    for (const staker of poolRounds.keys()) accrueUntil(poolAppId, staker, endRound)
  }

  return microAlgoRounds
}

/**
 * Sum a staker's microALGO-rounds across a set of pools — still unfloored, so the caller can floor
 * once over exactly the pools it is scoped to.
 * @param poolAppIds pools to include; omit for every pool in the accrual (the whole protocol)
 */
export function sumMicroAlgoRounds(
  microAlgoRounds: MicroAlgoRoundsByPool,
  poolAppIds?: Iterable<bigint>,
): Map<string, bigint> {
  const pools = poolAppIds === undefined ? microAlgoRounds.keys() : poolAppIds
  const totals = new Map<string, bigint>()
  for (const poolAppId of pools) {
    for (const [staker, contribution] of microAlgoRounds.get(poolAppId) ?? []) {
      totals.set(staker, (totals.get(staker) ?? 0n) + contribution)
    }
  }
  return totals
}

/**
 * Floor accrued microALGO-rounds to whole AQ, once per staker. Entries flooring to zero are kept,
 * so a caller can report how many stakers the 1 AQ eligibility cutoff dropped.
 */
export function toAlgoQuarters(microAlgoRounds: Map<string, bigint>): Map<string, bigint> {
  return new Map([...microAlgoRounds].map(([staker, contribution]) => [staker, contribution / MICROALGO_ROUNDS_PER_AQ]))
}

/**
 * Protocol-wide AQ: accrue, sum over every pool, floor once per staker. The unsliced path — what
 * the retired `algoquarters:reti` CLI produced, and what the archived manifests are checked against.
 */
export function computeRetiAlgoQuarters(
  pools: PoolLedger,
  events: RetiEvent[],
  epochRoundLengths: Map<bigint, bigint>,
  startRound: number,
  endRound: number,
): Map<string, bigint> {
  return toAlgoQuarters(
    sumMicroAlgoRounds(computeRetiMicroAlgoRounds(pools, events, epochRoundLengths, startRound, endRound)),
  )
}
