/** Time-weighted algohour calculation for reti staked balances. */

import { applyRetiEvent } from './ledger'
import type { PoolLedger, RetiEvent } from './types'

/**
 * Compute microALGO-hours over `[startTimestamp, endTimestamp)`.
 * Staked ALGO is native, so no rate is involved. The supplied pools are
 * modified during event replay.
 *
 * Accrual runs on each staker's aggregate balance across pools, and is
 * rounded once per staker when converting microALGO-seconds to microALGO-hours.
 */
export function computeRetiAlgoHours(
  pools: PoolLedger,
  events: RetiEvent[],
  epochRoundLengths: Map<bigint, bigint>,
  startTimestamp: number,
  endTimestamp: number,
): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const pool of pools.values()) {
    for (const [staker, { balance }] of pool) {
      totals.set(staker, (totals.get(staker) ?? 0n) + balance)
    }
  }

  const microAlgoSeconds = new Map<string, bigint>()
  const lastAccruedTimestamp = new Map<string, number>()

  function accrueUntil(staker: string, timestamp: number): void {
    const previousTimestamp = lastAccruedTimestamp.get(staker)
    // First time this staker appears in the window; start tracking it here
    if (previousTimestamp === undefined) {
      lastAccruedTimestamp.set(staker, timestamp)
      return
    }

    // No time has elapsed since the last accrual, nothing to do
    const elapsedSeconds = timestamp - previousTimestamp
    if (elapsedSeconds === 0) return
    if (elapsedSeconds < 0) throw new Error('Non-monotonic timestamp')

    // Time has elapsed for the staker, accrue contribution
    const balance = totals.get(staker) ?? 0n
    if (balance > 0n) {
      microAlgoSeconds.set(staker, (microAlgoSeconds.get(staker) ?? 0n) + balance * BigInt(elapsedSeconds))
    }
    lastAccruedTimestamp.set(staker, timestamp)
  }

  for (const [staker, balance] of totals) {
    if (balance > 0n) {
      lastAccruedTimestamp.set(staker, startTimestamp)
    }
  }

  for (const event of events) {
    // Accrue everyone the event touches before mutating balances
    if (event.type === 'epochRewardUpdate') {
      for (const staker of pools.get(event.poolAppId)?.keys() ?? []) {
        accrueUntil(staker, event.timestamp)
      }
    } else {
      accrueUntil(event.staker, event.timestamp)
    }

    for (const { staker, delta } of applyRetiEvent(pools, event, epochRoundLengths)) {
      totals.set(staker, (totals.get(staker) ?? 0n) + delta)
    }
  }

  for (const staker of lastAccruedTimestamp.keys()) {
    accrueUntil(staker, endTimestamp)
  }

  // Convert seconds to hours
  return new Map([...microAlgoSeconds].map(([staker, contribution]) => [staker, contribution / 3_600n]))
}
