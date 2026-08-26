/** Round-weighted accrual invariants for src/plugins/reti/compute.ts. */

import { describe, it, expect } from 'vitest'

import {
  computeRetiAlgoQuarters,
  computeRetiMicroAlgoRounds,
  sumMicroAlgoRounds,
  toAlgoQuarters,
} from '../../src/plugins/reti/compute.ts'
import { MICROALGO_ROUNDS_PER_AQ } from '../../src/aq/index.ts'
import type { RetiEvent } from '../../src/plugins/reti/types.ts'
import { ALICE, BOB, CAROL } from '../helpers.ts'
import { EPOCH_LENGTHS, POOL_A, POOL_B, makeEpochReward, makeStakeAdded, makeStakeRemoved, poolsOf } from './helpers.ts'

// 1 ALGO held for QUARTER rounds = 1 AQ
const QUARTER = 3_000_000

function compute(pools: ReturnType<typeof poolsOf>, events: RetiEvent[], start: number, end: number) {
  return computeRetiAlgoQuarters(pools, events, EPOCH_LENGTHS, start, end)
}

describe('computeRetiAlgoQuarters', () => {
  it('credits a constant staker exactly balance × quarters', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 1_000_000n, 320]]])
    const algoQuarters = compute(pools, [], 0, 2 * QUARTER)
    expect(algoQuarters.get(ALICE)).toBe(2n)
  })

  it('totalizes to the integral of total stake over rounds', () => {
    // ALICE holds 1 ALGO all window; BOB adds 2 ALGO halfway: 1×1Q + 2×0.5Q
    const pools = poolsOf([POOL_A, [[ALICE, 1_000_000n, 320]]])
    const events = [makeStakeAdded(BOB, 2_000_000n, { round: QUARTER / 2 })]
    const algoQuarters = compute(pools, events, 0, QUARTER)
    expect(algoQuarters.get(ALICE)).toBe(1n)
    expect(algoQuarters.get(BOB)).toBe(1n)
  })

  it('accrues on the aggregate balance across pools', () => {
    const twoPools = poolsOf([POOL_A, [[ALICE, 10_000_000n, 320]]], [POOL_B, [[ALICE, 20_000_000n, 320]]])
    const onePool = poolsOf([POOL_A, [[ALICE, 30_000_000n, 320]]])
    expect(compute(twoPools, [], 0, 5 * QUARTER).get(ALICE)).toEqual(compute(onePool, [], 0, 5 * QUARTER).get(ALICE))
  })

  it('stops accrual at a full unstake', () => {
    // 2 ALGO staked for half a window: 1 AQ
    const pools = poolsOf([POOL_A, [[ALICE, 2_000_000n, 320]]])
    const events = [makeStakeRemoved(ALICE, 2_000_000n, { round: QUARTER / 2 })]
    expect(compute(pools, events, 0, QUARTER).get(ALICE)).toBe(1n)
  })

  it('raises accrual after an epoch reward is credited', () => {
    // ALICE full-epoch (entry 5320 ≪ payout at round 1.5M): +2 ALGO at half window
    const pools = poolsOf([POOL_A, [[ALICE, 2_000_000n, 5_320]]])
    const events = [makeEpochReward(2_000_000n, { round: QUARTER / 2 })]
    expect(compute(pools, events, 0, QUARTER).get(ALICE)).toBe(1n + 2n)
  })

  it('allocates a mixed full/partial epoch reward exactly, across pools and a final unstake', () => {
    // POOL_A: ALICE is full-epoch at the payout, BOB joins mid-epoch (301/1000 of the epoch)
    const pools = poolsOf([POOL_A, [[ALICE, 6_000_000_000n, 320]]], [POOL_B, [[ALICE, 1_000_000_000n, 320]]])
    const events = [
      makeStakeAdded(BOB, 4_000_000_000n, { round: 1_379 }),
      // Split of 100_000 ALGO: BOB 4000×100000×301/(10000×1000) = 12_040 ALGO, ALICE the remaining 87_960
      makeEpochReward(100_000_000_000n, { round: 2_500 }),
      makeStakeRemoved(BOB, 16_040_000_000n, { round: 3_000 }),
    ]
    const algoQuarters = compute(pools, events, 0, 30_000)

    // ALICE: 7000 ALGO × 2500 rounds, then (6000+87_960+1000) ALGO × 27500 rounds across both pools
    expect(algoQuarters.get(ALICE)).toBe(
      (7_000_000_000n * 2_500n + 94_960_000_000n * 27_500n) / MICROALGO_ROUNDS_PER_AQ,
    )
    // BOB: 4000 ALGO × 1121 rounds, then 16_040 ALGO × 500 rounds until the full unstake
    expect(algoQuarters.get(BOB)).toBe((4_000_000_000n * 1_121n + 16_040_000_000n * 500n) / MICROALGO_ROUNDS_PER_AQ)
  })

  it('conserves sum of algoquarters == total stake × rounds through rewards, adds and removals', () => {
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
      makeStakeAdded(CAROL, 2_000_000_777n, { round: 700 }),
      makeEpochReward(1_234_567n, { round: 2_500 }), // POOL_A, mixed full/partial
      makeEpochReward(999_983n, { poolAppId: POOL_B, round: 3_100 }),
      makeStakeRemoved(BOB, 1_000_000_000n, { round: 3_600 }), // partial
      makeStakeAdded(BOB, 500_000_009n, { round: 4_200 }), // top-up, resets entryRound
    ]
    const endRound = 14_537

    const algoQuarters = compute(pools, events, 0, endRound)

    // Integral of total stake over rounds, folded independently from the raw event amounts
    let total = 7_000_000_000n + 3_000_000_123n + 5_500_000_000n
    let microAlgoRounds = 0n
    let last = 0
    for (const event of events) {
      microAlgoRounds += total * BigInt(event.round - last)
      last = event.round
      if (event.type === 'stakeAdded') total += event.amount
      else if (event.type === 'stakeRemoved') total -= event.amount
      else total += event.algoAdded
    }
    microAlgoRounds += total * BigInt(endRound - last)

    const summed = [...algoQuarters.values()].reduce((sum, quarters) => sum + quarters, 0n)
    const exactTotal = microAlgoRounds / MICROALGO_ROUNDS_PER_AQ
    expect(summed).toBeLessThanOrEqual(exactTotal)
    expect(exactTotal - summed).toBeLessThan(BigInt(algoQuarters.size))
  })

  it('splits across chained windows exactly like one window when both windows floor cleanly', () => {
    const events = [
      makeStakeAdded(BOB, 6_000_000n, { round: 500_000 }),
      // Both stakers full-epoch → proportional split: ALICE +3, BOB +6 ALGO
      makeEpochReward(9_000_000n, { round: 1_000_000 }),
      makeStakeRemoved(BOB, 12_000_000n, { round: 1_500_000 }),
    ]
    const single = compute(poolsOf([POOL_A, [[ALICE, 3_000_000n, 320]]]), events, 0, 2_000_000)

    // Chained: the first call mutates the pools into the boundary state at 1M rounds
    const pools = poolsOf([POOL_A, [[ALICE, 3_000_000n, 320]]])
    const first = compute(
      pools,
      events.filter((event) => event.round < 1_000_000),
      0,
      1_000_000,
    )
    const second = compute(
      pools,
      events.filter((event) => event.round >= 1_000_000),
      1_000_000,
      2_000_000,
    )
    for (const staker of [ALICE, BOB]) {
      expect((first.get(staker) ?? 0n) + (second.get(staker) ?? 0n)).toBe(single.get(staker))
    }
  })

  it('throws on non-monotonic event rounds', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 3_600n, 320]]])
    const events = [makeStakeAdded(ALICE, 1_000n, { round: 500 }), makeStakeAdded(ALICE, 1_000n, { round: 400 })]
    expect(() => compute(pools, events, 0, QUARTER)).toThrow(/Non-monotonic/)
  })
})

// The accrual underneath, keyed by (pool, staker) and unfloored. This is what lets one window scan
// serve every frac instance of the committee: an instance covers one validator's committee pools,
// so it is credited from exactly those pools' entries.
describe('computeRetiMicroAlgoRounds', () => {
  function accrue(pools: ReturnType<typeof poolsOf>, events: RetiEvent[], start: number, end: number) {
    return computeRetiMicroAlgoRounds(pools, events, EPOCH_LENGTHS, start, end)
  }

  it('keys a multi-pool staker per pool, and the pools sum to the aggregate', () => {
    const perPool = accrue(
      poolsOf([POOL_A, [[ALICE, 10_000_000n, 320]]], [POOL_B, [[ALICE, 20_000_000n, 320]]]),
      [],
      0,
      QUARTER,
    )

    expect(perPool.get(POOL_A)?.get(ALICE)).toBe(10_000_000n * BigInt(QUARTER))
    expect(perPool.get(POOL_B)?.get(ALICE)).toBe(20_000_000n * BigInt(QUARTER))
    expect(sumMicroAlgoRounds(perPool).get(ALICE)).toBe(30_000_000n * BigInt(QUARTER))
  })

  it('credits a pool slice only the stake held in that pool', () => {
    const perPool = accrue(
      poolsOf([POOL_A, [[ALICE, 10_000_000n, 320]]], [POOL_B, [[ALICE, 20_000_000n, 320]]]),
      [],
      0,
      QUARTER,
    )

    expect(sumMicroAlgoRounds(perPool, [POOL_A]).get(ALICE)).toBe(10_000_000n * BigInt(QUARTER))
    expect(sumMicroAlgoRounds(perPool, [POOL_B]).get(ALICE)).toBe(20_000_000n * BigInt(QUARTER))
  })

  it("keeps a pool's epoch reward out of the other pools it does not touch", () => {
    // ALICE is in both pools; only POOL_A pays out, so only POOL_A's accrual rises
    const events = [makeEpochReward(2_000_000n, { round: QUARTER / 2 })]
    const perPool = accrue(
      poolsOf([POOL_A, [[ALICE, 2_000_000n, 5_320]]], [POOL_B, [[ALICE, 2_000_000n, 5_320]]]),
      events,
      0,
      QUARTER,
    )

    expect(perPool.get(POOL_A)?.get(ALICE)).toBe(2_000_000n * BigInt(QUARTER / 2) + 4_000_000n * BigInt(QUARTER / 2))
    expect(perPool.get(POOL_B)?.get(ALICE)).toBe(2_000_000n * BigInt(QUARTER))
  })

  // Where the floor lands is the whole reason accrual is returned unfloored: 0.6 AQ in each of two
  // pools is 1 AQ protocol-wide but below the eligibility cutoff on either instance
  it('floors once per pool set, so slicing can drop what the aggregate keeps', () => {
    const perPool = accrue(
      poolsOf([POOL_A, [[ALICE, 600_000n, 320]]], [POOL_B, [[ALICE, 600_000n, 320]]]),
      [],
      0,
      QUARTER,
    )

    expect(toAlgoQuarters(sumMicroAlgoRounds(perPool)).get(ALICE)).toBe(1n)
    expect(toAlgoQuarters(sumMicroAlgoRounds(perPool, [POOL_A])).get(ALICE)).toBe(0n)
    expect(toAlgoQuarters(sumMicroAlgoRounds(perPool, [POOL_B])).get(ALICE)).toBe(0n)
  })

  // The invariant no archived manifest can check, since every archived figure is already floored:
  // slicing must only move where the floor is applied, never the accrual it is applied to
  it('sums every pool slice to the exact integral of total stake over rounds', () => {
    const makePools = () =>
      poolsOf(
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
      makeStakeAdded(CAROL, 2_000_000_777n, { round: 700 }),
      makeEpochReward(1_234_567n, { round: 2_500 }), // POOL_A, mixed full/partial
      makeEpochReward(999_983n, { poolAppId: POOL_B, round: 3_100 }),
      makeStakeRemoved(BOB, 1_000_000_000n, { round: 3_600 }), // partial
      makeStakeAdded(BOB, 500_000_009n, { round: 4_200 }), // top-up, resets entryRound
      makeStakeAdded(ALICE, 900_000_000n, { poolAppId: POOL_B, round: 5_000 }), // ALICE now spans both pools
    ]
    const endRound = 14_537

    // Integral of total stake over rounds, folded independently from the raw event amounts
    let total = 7_000_000_000n + 3_000_000_123n + 5_500_000_000n
    let microAlgoRounds = 0n
    let last = 0
    for (const event of events) {
      microAlgoRounds += total * BigInt(event.round - last)
      last = event.round
      if (event.type === 'stakeAdded') total += event.amount
      else if (event.type === 'stakeRemoved') total -= event.amount
      else total += event.algoAdded
    }
    microAlgoRounds += total * BigInt(endRound - last)

    const perPool = accrue(makePools(), events, 0, endRound)
    const summed = [...sumMicroAlgoRounds(perPool).values()].reduce((sum, contribution) => sum + contribution, 0n)
    // Exact, not within-flooring: nothing has been floored yet
    expect(summed).toBe(microAlgoRounds)

    // And the same accrual, aggregated and floored, is what the whole-protocol path returns
    expect(toAlgoQuarters(sumMicroAlgoRounds(perPool))).toEqual(
      computeRetiAlgoQuarters(makePools(), events, EPOCH_LENGTHS, 0, endRound),
    )
  })
})
