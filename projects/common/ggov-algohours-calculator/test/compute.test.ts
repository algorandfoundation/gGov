/**
 * Accrual invariants: totalization (Σ algohours == supply × rate × duration),
 * transfer/stake neutrality, window splitting, single rounding, replay ordering.
 */

import { describe, it, expect } from 'vitest'

import { computeAlgoHours, mergeAssetTransfers } from '../src/compute'
import { RATE_SCALER } from '../src/constants/tinyman'
import { ALICE, BOB, CAROL, ESCROW, balancesOf, makeTagged, makeTransfer } from './helpers'

const HOUR = 3600
const DIVISOR = RATE_SCALER * 3600n

describe('computeAlgoHours', () => {
  it('throws on non-monotonic timestamps', () => {
    const balances = balancesOf([ALICE, 1_000_000n, 0n])
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1n, timestamp: 100 }),
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1n, timestamp: 50 }),
    ]
    expect(() => computeAlgoHours(balances, transfers, 0, HOUR, RATE_SCALER)).toThrow(/Non-monotonic timestamp/)
  })

  it('earns nothing for a zero-balance account', () => {
    const balances = balancesOf([ALICE, 1_000_000n, 0n], [BOB, 0n, 0n])
    const result = computeAlgoHours(balances, [], 0, HOUR, RATE_SCALER)
    expect(result.get(BOB) ?? 0n).toBe(0n)
  })

  it('earns exactly balance × rate × hours for a constant holder', () => {
    // 1 ALGO held for 2 hours at 1:1 → 2 ALGO·h
    const oneToOne = computeAlgoHours(balancesOf([ALICE, 1_000_000n, 0n]), [], 0, 2 * HOUR, RATE_SCALER)
    expect(oneToOne.get(ALICE)).toBe(2_000_000n)

    // Same holding at rate 1.5 → 3 ALGO·h
    const oneAndHalf = computeAlgoHours(balancesOf([ALICE, 1_000_000n, 0n]), [], 0, 2 * HOUR, (RATE_SCALER * 3n) / 2n)
    expect(oneAndHalf.get(ALICE)).toBe(3_000_000n)
  })

  it('rounds once per account: result is the floor of the exact piecewise sum', () => {
    const rate = 1_234_567_890_123n
    const aliceStart = 999_983n
    const transferOut = 100_000n
    const balances = balancesOf([ALICE, aliceStart, 0n])
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: transferOut, timestamp: 1234 }),
      makeTagged('talgo', { sender: BOB, receiver: ALICE, amount: 40_000n, timestamp: 4321 }),
    ]
    const result = computeAlgoHours(balances, transfers, 0, 5000, rate)

    const aliceExact =
      aliceStart * rate * 1234n +
      (aliceStart - transferOut) * rate * (4321n - 1234n) +
      939_983n * rate * (5000n - 4321n)
    const bobExact = transferOut * rate * (4321n - 1234n) + 60_000n * rate * (5000n - 4321n)
    expect(result.get(ALICE)).toBe(aliceExact / DIVISOR)
    expect(result.get(BOB)).toBe(bobExact / DIVISOR)
  })

  it('totalization: the sum over ALL accounts equals supply × rate × duration, within per-account truncation', () => {
    const rate = 1_069_250_387_294n
    const balances = balancesOf([ALICE, 7_777_777n, 123n], [BOB, 3_333_333n, 0n], [ESCROW, 0n, 999_999n])
    const supply = 7_777_777n + 123n + 3_333_333n + 999_999n
    const durationSeconds = 4 * HOUR + 137
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 1_000_001n, timestamp: 991 }),
      // CAROL enters mid-window with no starting balance
      makeTagged('stalgo', { sender: ESCROW, receiver: CAROL, amount: 500_000n, timestamp: 5003 }),
      makeTagged('talgo', { sender: BOB, receiver: CAROL, amount: 4_000_000n, timestamp: 5003, intraOffset: 1 }),
      makeTagged('talgo', { sender: CAROL, receiver: ALICE, amount: 999_999n, timestamp: 12345 }),
    ]

    const result = computeAlgoHours(balances, transfers, 0, durationSeconds, rate)

    const summed = [...result.values()].reduce((sum, algoHours) => sum + algoHours, 0n)
    const exactTotal = (supply * rate * BigInt(durationSeconds)) / DIVISOR
    expect(summed).toBeLessThanOrEqual(exactTotal)
    expect(exactTotal - summed).toBeLessThan(BigInt(result.size))
  })

  it('a transfer never changes the combined algohours of its two parties', () => {
    const withoutTransfer = computeAlgoHours(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      [],
      0,
      4 * HOUR,
      RATE_SCALER,
    )
    const withTransfer = computeAlgoHours(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      [makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 2_000_000n, timestamp: HOUR })],
      0,
      4 * HOUR,
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
      timestamp: 2 * HOUR,
    })
    const result = computeAlgoHours(balances, [closeOut], 0, 4 * HOUR, RATE_SCALER)

    expect(result.get(ALICE)).toBe(10_000_000n) // 5 ALGO × 2h
    expect(result.get(BOB)).toBe(14_000_000n) // 3 ALGO × 2h + 4 ALGO × 2h
    expect(result.get(CAROL)).toBe(8_000_000n) // 4 ALGO × 2h (the close-out remainder)
  })

  it('staking (talgo → stalgo at parity) does not change the account algohours', () => {
    const holding = computeAlgoHours(
      balancesOf([ALICE, 5_000_000n, 0n], [ESCROW, 0n, 5_000_000n]),
      [],
      0,
      4 * HOUR,
      RATE_SCALER,
    )
    const staking = computeAlgoHours(
      balancesOf([ALICE, 5_000_000n, 0n], [ESCROW, 0n, 5_000_000n]),
      [
        makeTagged('talgo', { sender: ALICE, receiver: ESCROW, amount: 5_000_000n, timestamp: 2 * HOUR }),
        makeTagged('stalgo', {
          sender: ESCROW,
          receiver: ALICE,
          amount: 5_000_000n,
          timestamp: 2 * HOUR,
          intraOffset: 1,
        }),
      ],
      0,
      4 * HOUR,
      RATE_SCALER,
    )

    expect(staking.get(ALICE)).toBe(holding.get(ALICE))
    expect(staking.get(ALICE)).toBe(20_000_000n)
  })

  it('splitting a window at a boundary preserves every account total', () => {
    const transfers = [
      makeTagged('talgo', { sender: ALICE, receiver: BOB, amount: 2_000_000n, timestamp: HOUR }),
      makeTagged('talgo', { sender: BOB, receiver: ALICE, amount: 500_000n, timestamp: 3 * HOUR }),
    ]
    const full = computeAlgoHours(
      balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n]),
      transfers,
      0,
      4 * HOUR,
      RATE_SCALER,
    )

    // computeAlgoHours mutates the balances, so the first half leaves them ready for the second
    const balances = balancesOf([ALICE, 7_000_000n, 0n], [BOB, 3_000_000n, 0n])
    const firstHalf = computeAlgoHours(
      balances,
      transfers.filter((t) => t.timestamp < 2 * HOUR),
      0,
      2 * HOUR,
      RATE_SCALER,
    )
    const secondHalf = computeAlgoHours(
      balances,
      transfers.filter((t) => t.timestamp >= 2 * HOUR),
      2 * HOUR,
      4 * HOUR,
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
