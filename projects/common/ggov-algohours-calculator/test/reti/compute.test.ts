/** Time-weighted accrual invariants for src/reti/compute.ts. */

import { describe, it, expect } from 'vitest'

import { computeRetiAlgoHours } from '../../src/reti/compute'
import type { RetiEvent } from '../../src/reti/types'
import { ALICE, BOB, CAROL } from '../helpers'
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

  it('allocates a mixed full/partial epoch reward exactly, across pools and a final unstake', () => {
    // POOL_A: ALICE is full-epoch at the payout, BOB joins mid-epoch (301/1000 of the epoch)
    const pools = poolsOf([POOL_A, [[ALICE, 600n, 320]]], [POOL_B, [[ALICE, 100n, 320]]])
    const events = [
      makeStakeAdded(BOB, 400n, { round: 1_379, timestamp: HOUR }),
      // Split of 10_000: BOB 400×10000×301/(1000×1000) = 1204, ALICE the remaining 8796
      makeEpochReward(10_000n, { round: 2_500, timestamp: 2 * HOUR }),
      makeStakeRemoved(BOB, 1_604n, { round: 3_000, timestamp: 3 * HOUR }),
    ]
    const algoHours = compute(pools, events, 0, 4 * HOUR)

    // ALICE: (600+100)×2h, then (600+8796+100)×2h across both pools
    expect(algoHours.get(ALICE)).toBe(700n * 2n + 9_496n * 2n)
    // BOB: 400×1h, then (400+1204)×1h until the full unstake
    expect(algoHours.get(BOB)).toBe(400n + 1_604n)
  })

  it('conserves sum of algohours == total stake × time through rewards, adds and removals', () => {
    const pools = poolsOf(
      [
        POOL_A,
        [
          [ALICE, 7_000_000_000n, 320],
          [BOB, 3_000_000_123n, 500],
        ],
      ],
      [POOL_B, [[CAROL, 5_500_000_000n, 320]]],
    )
    const events = [
      makeStakeAdded(CAROL, 2_000_000_777n, { round: 700, timestamp: 991 }),
      makeEpochReward(1_234_567n, { round: 2_500, timestamp: 5_003 }), // POOL_A, mixed full/partial
      makeEpochReward(999_983n, { poolAppId: POOL_B, round: 3_100, timestamp: 7_043 }),
      makeStakeRemoved(BOB, 1_000_000_000n, { round: 3_600, timestamp: 9_781 }), // partial
      makeStakeAdded(BOB, 500_000_009n, { round: 4_200, timestamp: 12_007 }), // top-up, resets entryRound
    ]
    const endTimestamp = 4 * HOUR + 137

    const algoHours = compute(pools, events, 0, endTimestamp)

    // Integral of total stake over time, folded independently from the raw event amounts
    let total = 7_000_000_000n + 3_000_000_123n + 5_500_000_000n
    let microAlgoSeconds = 0n
    let last = 0
    for (const event of events) {
      microAlgoSeconds += total * BigInt(event.timestamp - last)
      last = event.timestamp
      if (event.type === 'stakeAdded') total += event.amount
      else if (event.type === 'stakeRemoved') total -= event.amount
      else total += event.algoAdded
    }
    microAlgoSeconds += total * BigInt(endTimestamp - last)

    const summed = [...algoHours.values()].reduce((sum, hours) => sum + hours, 0n)
    const exactTotal = microAlgoSeconds / 3_600n
    expect(summed).toBeLessThanOrEqual(exactTotal)
    expect(exactTotal - summed).toBeLessThan(BigInt(algoHours.size))
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
