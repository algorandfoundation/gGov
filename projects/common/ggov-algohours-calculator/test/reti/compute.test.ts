/** Time-weighted accrual invariants for src/reti/compute.ts. */

import { describe, it, expect } from 'vitest'

import { computeRetiAlgoHours } from '../../src/reti/compute'
import type { RetiEvent } from '../../src/reti/types'
import { ALICE, BOB } from '../helpers'
import { EPOCH_LENGTHS, POOL_A, POOL_B, makeEpochReward, makeStakeAdded, makeStakeRemoved, poolsOf } from './helpers'

const HOUR = 3_600

function compute(pools: ReturnType<typeof poolsOf>, events: RetiEvent[], start: number, end: number) {
  return computeRetiAlgoHours(pools, events, EPOCH_LENGTHS, start, end)
}

describe('computeRetiAlgoHours', () => {
  it('credits a constant staker exactly balance × hours', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 7_200n, 320]]])
    const algoHours = compute(pools, [], 0, 2 * HOUR)
    expect(algoHours.get(ALICE)).toBe(14_400n)
  })

  it('totalizes to the integral of total stake over time', () => {
    // ALICE holds 3600 all window; BOB adds 7200 halfway: 3600×1h + 7200×0.5h
    const pools = poolsOf([POOL_A, [[ALICE, 3_600n, 320]]])
    const events = [makeStakeAdded(BOB, 7_200n, { round: 500, timestamp: HOUR / 2 })]
    const algoHours = compute(pools, events, 0, HOUR)
    expect(algoHours.get(ALICE)).toBe(3_600n)
    expect(algoHours.get(BOB)).toBe(3_600n)
  })

  it('accrues on the aggregate balance across pools', () => {
    const twoPools = poolsOf([POOL_A, [[ALICE, 1_000n, 320]]], [POOL_B, [[ALICE, 2_000n, 320]]])
    const onePool = poolsOf([POOL_A, [[ALICE, 3_000n, 320]]])
    expect(compute(twoPools, [], 0, 5 * HOUR).get(ALICE)).toEqual(compute(onePool, [], 0, 5 * HOUR).get(ALICE))
  })

  it('stops accrual at a full unstake', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 3_600n, 320]]])
    const events = [makeStakeRemoved(ALICE, 3_600n, { round: 500, timestamp: HOUR / 2 })]
    expect(compute(pools, events, 0, HOUR).get(ALICE)).toBe(1_800n)
  })

  it('raises accrual after an epoch reward is credited', () => {
    // ALICE full-epoch (entry 5320 ≪ payout at round 10_000): +3600 at half window
    const pools = poolsOf([POOL_A, [[ALICE, 3_600n, 5_320]]])
    const events = [makeEpochReward(3_600n, { round: 10_000, timestamp: HOUR / 2 })]
    expect(compute(pools, events, 0, HOUR).get(ALICE)).toBe(1_800n + 3_600n)
  })

  it('splits across chained windows exactly like one window', () => {
    const events = [
      makeStakeAdded(BOB, 7_200_000n, { round: 400, timestamp: HOUR / 2 }),
      makeEpochReward(1_000_000n, { round: 10_000, timestamp: HOUR }),
      makeStakeRemoved(BOB, 3_600_000n, { round: 11_000, timestamp: HOUR + HOUR / 2 }),
    ]
    const single = compute(poolsOf([POOL_A, [[ALICE, 3_600_000n, 320]]]), events, 0, 2 * HOUR)

    // Chained: the first call mutates the pools into the boundary state at HOUR
    const pools = poolsOf([POOL_A, [[ALICE, 3_600_000n, 320]]])
    const first = compute(
      pools,
      events.filter((event) => event.timestamp < HOUR),
      0,
      HOUR,
    )
    const second = compute(
      pools,
      events.filter((event) => event.timestamp >= HOUR),
      HOUR,
      2 * HOUR,
    )
    for (const staker of [ALICE, BOB]) {
      expect((first.get(staker) ?? 0n) + (second.get(staker) ?? 0n)).toBe(single.get(staker))
    }
  })

  it('throws on non-monotonic event timestamps', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 3_600n, 320]]])
    const events = [
      makeStakeAdded(ALICE, 1_000n, { round: 500, timestamp: 100 }),
      makeStakeAdded(ALICE, 1_000n, { round: 600, timestamp: 50 }),
    ]
    expect(() => compute(pools, events, 0, HOUR)).toThrow(/Non-monotonic/)
  })
})
