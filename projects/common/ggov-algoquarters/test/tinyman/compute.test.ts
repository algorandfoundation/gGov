/**
 * Accrual invariants: totalization (Σ algoquarters == supply × rate × duration),
 * transfer/stake neutrality, window splitting, single flooring, replay ordering.
 */

import { describe, it, expect } from 'vitest'

import { computeAlgoQuarters, mergeAssetTransfers } from '../../src/tinyman/compute'
import { RATE_SCALER } from '../../src/tinyman/constants'
import { MICROALGO_ROUNDS_PER_AQ } from '../../src/utils/aq'
import { ALICE, BOB, CAROL, ESCROW, balancesOf, makeTagged, makeTransfer } from '../helpers'

// 1 ALGO held for QUARTER rounds = 1 AQ
const QUARTER = 3_000_000
const DIVISOR = RATE_SCALER * MICROALGO_ROUNDS_PER_AQ

describe('computeAlgoQuarters', () => {
  it('throws on non-monotonic rounds', () => {
    const balances = balancesOf([ALICE, 1_000_000n, 0n])
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1n, round: 100 }),
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1n, round: 50 }),
    ]
    expect(() => computeAlgoQuarters(balances, transfers, 0, QUARTER, RATE_SCALER)).toThrow(/Non-monotonic round/)
  })

  it('earns nothing for a zero-balance account', () => {
    const balances = balancesOf([ALICE, 1_000_000n, 0n], [BOB, 0n, 0n])
    const result = computeAlgoQuarters(balances, [], 0, QUARTER, RATE_SCALER)
    expect(result.get(BOB) ?? 0n).toBe(0n)
  })

  it('earns exactly balance × rate × quarters for a constant holder', () => {
    // 1 ALGO held for 2 quarters at 1:1 → 2 AQ
    const oneToOne = computeAlgoQuarters(balancesOf([ALICE, 1_000_000n, 0n]), [], 0, 2 * QUARTER, RATE_SCALER)
    expect(oneToOne.get(ALICE)).toBe(2n)

    // Same holding at rate 1.5 → 3 AQ
    const oneAndHalf = computeAlgoQuarters(
      balancesOf([ALICE, 1_000_000n, 0n]),
      [],
      0,
      2 * QUARTER,
      (RATE_SCALER * 3n) / 2n,
    )
    expect(oneAndHalf.get(ALICE)).toBe(3n)
  })

  it('floors once per account: result is the floor of the exact piecewise sum', () => {
    const rate = 1_234_567_890_123n
    const aliceStart = 999_983_000_000n
    const transferOut = 100_000_000_000n
    const balances = balancesOf([ALICE, aliceStart, 0n])
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: transferOut, round: 1_234_000 }),
      makeTagged('talgo', { sender: BOB, receiver: ALICE, amount: 40_000_000_000n, round: 4_321_000 }),
    ]
    const result = computeAlgoQuarters(balances, transfers, 0, 5_000_000, rate)

    const aliceExact =
      aliceStart * rate * 1_234_000n +
      (aliceStart - transferOut) * rate * (4_321_000n - 1_234_000n) +
      939_983_000_000n * rate * (5_000_000n - 4_321_000n)
    const bobExact = transferOut * rate * (4_321_000n - 1_234_000n) + 60_000_000_000n * rate * (5_000_000n - 4_321_000n)
    expect(result.get(ALICE)).toBe(aliceExact / DIVISOR)
    expect(result.get(BOB)).toBe(bobExact / DIVISOR)
  })

  it('totalization: the sum over ALL accounts equals supply × rate × duration, within per-account truncation', () => {
    const rate = 1_069_250_387_294n
    const balances = balancesOf(
      [ALICE, 7_777_777_000n, 123_000n],
      [BOB, 3_333_333_000n, 0n],
      [ESCROW, 0n, 999_999_000n],
    )
    const supply = 7_777_777_000n + 123_000n + 3_333_333_000n + 999_999_000n
    const durationRounds = 4 * QUARTER + 137
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1_000_001_000n, round: 991_000 }),
      // CAROL enters mid-window with no starting balance
      makeTagged('stalgo', { sender: ESCROW, receiver: CAROL, amount: 500_000_000n, round: 5_003_000 }),
      makeTagged('talgo', { sender: BOB, receiver: CAROL, amount: 4_000_000_000n, round: 5_003_000, intraOffset: 1 }),
      makeTagged('talgo', { sender: CAROL, receiver: ALICE, amount: 999_999_000n, round: 11_345_000 }),
    ]

    const result = computeAlgoQuarters(balances, transfers, 0, durationRounds, rate)

    const summed = [...result.values()].reduce((sum, quarters) => sum + quarters, 0n)
    const exactTotal = (supply * rate * BigInt(durationRounds)) / DIVISOR
    expect(summed).toBeLessThanOrEqual(exactTotal)
    expect(exactTotal - summed).toBeLessThan(BigInt(result.size))
  })

  it('a transfer preserves combined algoquarters when both sides floor to whole AQ', () => {
    const withoutTransfer = computeAlgoQuarters(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      [],
      0,
      4 * QUARTER,
      RATE_SCALER,
    )
    const withTransfer = computeAlgoQuarters(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      [makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 2_000_000n, round: QUARTER })],
      0,
      4 * QUARTER,
      RATE_SCALER,
    )

    expect(withTransfer.get(ALICE)! + withTransfer.get(BOB)!).toBe(
      withoutTransfer.get(ALICE)! + withoutTransfer.get(BOB)!,
    )
  })

  it('a close-out accrues the sender up to the close and the closeTo party from it', () => {
    const balances = balancesOf([ALICE, 5_000_000n, 0n], [BOB, 3_000_000n, 0n])
    const closeOut = makeTagged('talgo', {
      sender: ALICE,
      receiver: BOB,
      amount: 1_000_000n,
      closeTo: CAROL,
      round: 2 * QUARTER,
    })
    const result = computeAlgoQuarters(balances, [closeOut], 0, 4 * QUARTER, RATE_SCALER)

    expect(result.get(ALICE)).toBe(10n) // 5 ALGO × 2 quarters
    expect(result.get(BOB)).toBe(14n) // 3 ALGO × 2 quarters + 4 ALGO × 2 quarters
    expect(result.get(CAROL)).toBe(8n) // 4 ALGO × 2 quarters (the close-out remainder)
  })

  it('staking (talgo → stalgo at parity) does not change the account algoquarters', () => {
    const holding = computeAlgoQuarters(
      balancesOf([ALICE, 5_000_000n, 0n], [ESCROW, 0n, 5_000_000n]),
      [],
      0,
      4 * QUARTER,
      RATE_SCALER,
    )
    const staking = computeAlgoQuarters(
      balancesOf([ALICE, 5_000_000n, 0n], [ESCROW, 0n, 5_000_000n]),
      [
        makeTagged('talgo', { sender: ALICE, receiver: ESCROW, amount: 5_000_000n, round: 2 * QUARTER }),
        makeTagged('stalgo', {
          sender: ESCROW,
          receiver: ALICE,
          amount: 5_000_000n,
          round: 2 * QUARTER,
          intraOffset: 1,
        }),
      ],
      0,
      4 * QUARTER,
      RATE_SCALER,
    )

    expect(staking.get(ALICE)).toBe(holding.get(ALICE))
    expect(staking.get(ALICE)).toBe(20n)
  })

  it('does not double-count the boundary round: a full transfer gives the sender [start, T) and the receiver [T, end)', () => {
    // A balance of exactly MICROALGO_ROUNDS_PER_AQ at rate 1:1 earns precisely 1 AQ per round,
    // so per-round attribution is visible in whole AQ (a boundary off-by-one would shift a whole AQ).
    const PER_ROUND = MICROALGO_ROUNDS_PER_AQ // 1 AQ / round at rate 1:1

    // The scenario from the task: ALICE holds from round 1 and sends it ALL to BOB at round 5.
    // Expected: ALICE is credited [1, 5) (4 rounds), BOB [5, 10) (5 rounds) — round 5 belongs to BOB only.
    const start = 1
    const transferRound = 5
    const end = 10
    const result = computeAlgoQuarters(
      balancesOf([ALICE, PER_ROUND, 0n]),
      [makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: PER_ROUND, round: transferRound })],
      start,
      end,
      RATE_SCALER,
    )

    expect(result.get(ALICE)).toBe(BigInt(transferRound - start)) // [1, 5) → 4 AQ
    expect(result.get(BOB)).toBe(BigInt(end - transferRound)) // [5, 10) → 5 AQ
    // The boundary round is counted exactly once: the two sides sum to the whole window, no more, no less.
    expect(result.get(ALICE)! + result.get(BOB)!).toBe(BigInt(end - start)) // 9 AQ
  })

  it('does not double-count when the same balance hops A → B → C, each hop crediting the boundary once', () => {
    const PER_ROUND = MICROALGO_ROUNDS_PER_AQ
    const result = computeAlgoQuarters(
      balancesOf([ALICE, PER_ROUND, 0n]),
      [
        makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: PER_ROUND, round: 4 }),
        makeTagged('talgo', { sender: BOB, receiver: CAROL, amount: PER_ROUND, round: 9 }),
      ],
      1,
      12,
      RATE_SCALER,
    )

    expect(result.get(ALICE)).toBe(3n) // [1, 4)
    expect(result.get(BOB)).toBe(5n) // [4, 9)
    expect(result.get(CAROL)).toBe(3n) // [9, 12)
    // Every round of the window is attributed to exactly one holder.
    expect(result.get(ALICE)! + result.get(BOB)! + result.get(CAROL)!).toBe(11n) // [1, 12)
  })

  it('splitting a window at a boundary preserves every account total when both windows floor cleanly', () => {
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 2_000_000n, round: QUARTER }),
      makeTagged('talgo', { sender: BOB, receiver: ALICE, amount: 1_000_000n, round: 3 * QUARTER }),
    ]
    const full = computeAlgoQuarters(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      transfers,
      0,
      4 * QUARTER,
      RATE_SCALER,
    )

    // computeAlgoQuarters mutates the balances, so the first half leaves them ready for the second
    const balances = balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n])
    const firstHalf = computeAlgoQuarters(
      balances,
      transfers.filter((t) => t.round < 2 * QUARTER),
      0,
      2 * QUARTER,
      RATE_SCALER,
    )
    const secondHalf = computeAlgoQuarters(
      balances,
      transfers.filter((t) => t.round >= 2 * QUARTER),
      2 * QUARTER,
      4 * QUARTER,
      RATE_SCALER,
    )

    for (const account of [ALICE, BOB]) {
      expect((firstHalf.get(account) ?? 0n) + (secondHalf.get(account) ?? 0n)).toBe(full.get(account))
    }
  })
})

describe('mergeAssetTransfers', () => {
  it('sorts strictly by (round, intraOffset) whatever the input order, preserving asset tags', () => {
    const tAlgo = [
      makeTransfer({ sender: ALICE, receiver: BOB, amount: 1n, round: 7, intraOffset: 2 }),
      makeTransfer({ sender: ALICE, receiver: BOB, amount: 2n, round: 3, intraOffset: 0 }),
    ]
    const stAlgo = [
      makeTransfer({ sender: BOB, receiver: ALICE, amount: 3n, round: 7, intraOffset: 1 }),
      makeTransfer({ sender: BOB, receiver: ALICE, amount: 4n, round: 5, intraOffset: 9 }),
    ]

    const merged = mergeAssetTransfers(tAlgo, stAlgo)

    expect(merged.map((t) => [t.round, t.intraOffset, t.asset])).toEqual([
      [3, 0, 'talgo'],
      [5, 9, 'stalgo'],
      [7, 1, 'stalgo'],
      [7, 2, 'talgo'],
    ])
  })
})
