/** Reward-split replication and event application invariants for src/reti/ledger.ts. */

import { describe, it, expect } from 'vitest'

import { STAKING_BLOCK_DELAY } from '../../src/reti/constants.ts'
import { applyRetiEvent, splitReward, totalStaked } from '../../src/reti/ledger.ts'
import { ALICE, BOB, CAROL } from '../helpers.ts'
import {
  EPOCH_LENGTH,
  EPOCH_LENGTHS,
  POOL_A,
  makeEpochReward,
  makeStakeAdded,
  makeStakeRemoved,
  poolOf,
  poolsOf,
} from './helpers.ts'

// Epoch boundaries are multiples of EPOCH_LENGTH (1000); a payout at round 10_000 settles
// the epoch [9000, 10000). Entry rounds pick each staker's time-in-epoch bucket:
const PAYOUT_ROUND = 10_000
const FULL_ENTRY = 8_000 // a full epoch before the payout's epoch began
const HALF_ENTRY = 9_500 // in pool for 50% of the settled epoch
const QUARTER_ENTRY = 9_750 // 25%
const LATE_ENTRY = 10_500 // entered after the epoch began — earns nothing

function split(pool: Map<string, { balance: bigint; entryRound: number }>, algoAdded: bigint) {
  return splitReward(pool, algoAdded, PAYOUT_ROUND, EPOCH_LENGTH)
}

describe('splitReward', () => {
  it('credits exactly algoAdded in every pool composition', () => {
    const pools = [
      poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400n, FULL_ENTRY]),
      poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400n, HALF_ENTRY]),
      poolOf([BOB, 400n, HALF_ENTRY], [CAROL, 600n, QUARTER_ENTRY]),
      poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400n, HALF_ENTRY], [CAROL, 5n, LATE_ENTRY]),
    ]
    for (const pool of pools) {
      for (const algoAdded of [1n, 35n, 101n, 999_999_937n]) {
        const shares = split(pool, algoAdded)
        const credited = [...shares.values()].reduce((sum, share) => sum + share, 0n)
        expect(credited).toBe(algoAdded)
      }
    }
  })

  it('splits proportionally by stake among full-epoch stakers', () => {
    const shares = split(poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400n, FULL_ENTRY]), 100n)
    expect(shares.get(ALICE)).toBe(60n)
    expect(shares.get(BOB)).toBe(40n)
  })

  it('gives a single full-epoch staker the whole reward', () => {
    const shares = split(poolOf([ALICE, 123_456_789n, FULL_ENTRY]), 999n)
    expect(shares.get(ALICE)).toBe(999n)
  })

  it('prorates a mid-epoch joiner and hands the rest to full-epoch stakers', () => {
    // Pot recovery is trivial here (fulls absorb everything): pot 100, BOB gets 100×0.4×50% = 20
    const shares = split(poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400n, HALF_ENTRY]), 100n)
    expect(shares.get(BOB)).toBe(20n)
    expect(shares.get(ALICE)).toBe(80n)
  })

  it('recovers the pre-split pot when every staker is partial', () => {
    // Contract pot was 100: BOB ⌊400×100×500/(1000×1000)⌋ = 20, CAROL ⌊600×100×250/(1000×1000)⌋ = 15,
    // the un-prorated 65 stayed in the pool and the event only carries algoAdded = 35.
    const shares = split(poolOf([BOB, 400n, HALF_ENTRY], [CAROL, 600n, QUARTER_ENTRY]), 35n)
    expect(shares.get(BOB)).toBe(20n)
    expect(shares.get(CAROL)).toBe(15n)
  })

  it('gives nothing to stakers who entered after the epoch began', () => {
    const shares = split(poolOf([ALICE, 600n, FULL_ENTRY], [BOB, 400_000n, LATE_ENTRY]), 100n)
    expect(shares.get(BOB)).toBeUndefined()
    expect(shares.get(ALICE)).toBe(100n)
  })

  it('throws on a pool with no stake', () => {
    expect(() => split(poolOf(), 10n)).toThrow(/no stake/)
  })

  it('throws when no pot can produce the credited total', () => {
    // Everyone entered after the epoch began, yet the chain credited something
    expect(() => split(poolOf([ALICE, 1_000n, LATE_ENTRY]), 5n)).toThrow(/No reward can credit/)
  })
})

describe('applyRetiEvent', () => {
  it('creates a staker with entryRound = add round + delay', () => {
    const pools = poolsOf()
    const deltas = applyRetiEvent(pools, makeStakeAdded(ALICE, 5_000_000n, { round: 5_000 }), EPOCH_LENGTHS)
    expect(pools.get(POOL_A)!.get(ALICE)).toEqual({ balance: 5_000_000n, entryRound: 5_000 + STAKING_BLOCK_DELAY })
    expect(deltas).toEqual([{ staker: ALICE, delta: 5_000_000n }])
  })

  it('tops up balance and resets entryRound on every add', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 5_000_000n, 5_320]]])
    applyRetiEvent(pools, makeStakeAdded(ALICE, 2_000_000n, { round: 6_000 }), EPOCH_LENGTHS)
    expect(pools.get(POOL_A)!.get(ALICE)).toEqual({ balance: 7_000_000n, entryRound: 6_000 + STAKING_BLOCK_DELAY })
  })

  it('subtracts a partial unstake and preserves entryRound', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 5_000_000n, 5_320]]])
    const deltas = applyRetiEvent(pools, makeStakeRemoved(ALICE, 2_000_000n), EPOCH_LENGTHS)
    expect(pools.get(POOL_A)!.get(ALICE)).toEqual({ balance: 3_000_000n, entryRound: 5_320 })
    expect(deltas).toEqual([{ staker: ALICE, delta: -2_000_000n }])
  })

  it('removes the staker on a full unstake, returning the tracked balance as delta', () => {
    for (const tracked of [5_000_000n, 5_000_500n, 4_999_500n]) {
      // The chain pays 5_000_000; tracked may differ by a small reward-split residue
      const pools = poolsOf([POOL_A, [[ALICE, tracked, 5_320]]])
      const deltas = applyRetiEvent(pools, makeStakeRemoved(ALICE, 5_000_000n), EPOCH_LENGTHS)
      expect(pools.get(POOL_A)!.has(ALICE)).toBe(false)
      expect(deltas).toEqual([{ staker: ALICE, delta: -tracked }])
    }
  })

  it('throws when a full unstake leaves a residue beyond tolerance', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 5_020_000n, 5_320]]])
    expect(() => applyRetiEvent(pools, makeStakeRemoved(ALICE, 5_000_000n), EPOCH_LENGTHS)).toThrow(/residue/)
  })

  it('throws on a removal for an unknown staker', () => {
    expect(() => applyRetiEvent(poolsOf(), makeStakeRemoved(ALICE, 1_000_000n), EPOCH_LENGTHS)).toThrow(
      /unknown staker/,
    )
  })

  it('applies an epoch reward through splitReward and reports matching deltas', () => {
    const pools = poolsOf([
      POOL_A,
      [
        [ALICE, 600n, FULL_ENTRY],
        [BOB, 400n, HALF_ENTRY],
      ],
    ])
    const deltas = applyRetiEvent(pools, makeEpochReward(100n, { round: PAYOUT_ROUND }), EPOCH_LENGTHS)
    expect(pools.get(POOL_A)!.get(ALICE)!.balance).toBe(680n)
    expect(pools.get(POOL_A)!.get(BOB)!.balance).toBe(420n)
    expect(deltas.reduce((sum, { delta }) => sum + delta, 0n)).toBe(100n)
    expect(totalStaked(pools)).toBe(1_100n)
  })

  it('does nothing for an epoch reward of zero', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 600n, FULL_ENTRY]]])
    expect(applyRetiEvent(pools, makeEpochReward(0n), EPOCH_LENGTHS)).toEqual([])
    expect(pools.get(POOL_A)!.get(ALICE)!.balance).toBe(600n)
  })

  it('throws on an epoch reward for a validator with no fetched epoch length', () => {
    const pools = poolsOf([POOL_A, [[ALICE, 600n, FULL_ENTRY]]])
    expect(() => applyRetiEvent(pools, makeEpochReward(100n, { validatorId: 999n }), EPOCH_LENGTHS)).toThrow(
      /No epoch length/,
    )
  })
})
