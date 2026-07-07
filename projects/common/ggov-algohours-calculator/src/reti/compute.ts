/** Round-weighted algoquarter calculation for reti staked balances. */

import { applyRetiEvent } from './ledger'
import { MICROALGO_ROUNDS_PER_AQ } from '../utils/aq'
import type { PoolLedger, RetiEvent } from './types'

/**
 * Compute integer AQ over rounds `[startRound, endRound)`.
 * Staked ALGO is native, so no rate is involved. The supplied pools are
 * modified during event replay.
 *
 * Accrual runs on each staker's aggregate balance across pools, and is
 * floored once per staker when converting microALGO-rounds to AQ.
 */
export function computeRetiAlgoHours(
  pools: PoolLedger,
  events: RetiEvent[],
  epochRoundLengths: Map<bigint, bigint>,
  startRound: number,
  endRound: number,
): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const pool of pools.values()) {
    for (const [staker, { balance }] of pool) {
      totals.set(staker, (totals.get(staker) ?? 0n) + balance)
    }
  }

  const microAlgoRounds = new Map<string, bigint>()
  const lastAccruedRound = new Map<string, number>()

  function accrueUntil(staker: string, round: number): void {
    const previousRound = lastAccruedRound.get(staker)
    // First time this staker appears in the window; start tracking it here
    if (previousRound === undefined) {
      lastAccruedRound.set(staker, round)
      return
    }

    // No rounds have elapsed since the last accrual, nothing to do
    const elapsedRounds = round - previousRound
    if (elapsedRounds === 0) return
    if (elapsedRounds < 0) throw new Error('Non-monotonic round')

    // Rounds have elapsed for the staker, accrue contribution
    const balance = totals.get(staker) ?? 0n
    if (balance > 0n) {
      microAlgoRounds.set(staker, (microAlgoRounds.get(staker) ?? 0n) + balance * BigInt(elapsedRounds))
    }
    lastAccruedRound.set(staker, round)
  }

  for (const [staker, balance] of totals) {
    if (balance > 0n) {
      lastAccruedRound.set(staker, startRound)
    }
  }

  for (const event of events) {
    // Accrue everyone the event touches before mutating balances
    if (event.type === 'epochRewardUpdate') {
      for (const staker of pools.get(event.poolAppId)?.keys() ?? []) {
        accrueUntil(staker, event.round)
      }
    } else {
      accrueUntil(event.staker, event.round)
    }

    for (const { staker, delta } of applyRetiEvent(pools, event, epochRoundLengths)) {
      totals.set(staker, (totals.get(staker) ?? 0n) + delta)
    }
  }

  for (const staker of lastAccruedRound.keys()) {
    accrueUntil(staker, endRound)
  }

  // Convert microALGO-rounds to AQ
  return new Map([...microAlgoRounds].map(([staker, contribution]) => [staker, contribution / MICROALGO_ROUNDS_PER_AQ]))
}
