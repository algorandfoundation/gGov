/**
 * Attribution invariants for the xALGO replay: conservation, pool see-through (deposit ≡ direct
 * holding, pro-rata, utilization), escrow folding with single flooring, exclusions, window splitting,
 * ordering. Mirrors test/talgo/compute.test.ts and adds the pool index.
 */

import { describe, it, expect } from 'vitest'

import { MICROALGO_ROUNDS_PER_AQ } from '../../src/aq/index.ts'
import {
  collectBeneficiaryCandidates,
  computeAttribution,
  mergeAssetTransfers,
  toAlgoQuarters,
} from '../../src/plugins/xalgo/compute.ts'
import { INDEX_SCALE, RATE_SCALER } from '../../src/plugins/xalgo/constants.ts'
import { isExcluded } from '../../src/plugins/xalgo/exclusions.ts'
import { applyTransfer } from '../../src/plugins/xalgo/ledger.ts'
import type { BalanceMap, TaggedTransfer } from '../../src/plugins/xalgo/types.ts'
import {
  ALICE,
  BOB,
  CAROL,
  ESCROW1,
  ESCROW2,
  NO_ESCROWS,
  OWNER,
  POOL,
  QUARTER,
  RESERVE,
  cloneBalances,
  deposit,
  escrowsOf,
  makeTransfer,
  makeXalgoTagged,
  sumValues,
  withdraw,
  xalgoBalancesOf,
} from './helpers.ts'

const ONE_TO_ONE = RATE_SCALER
const AQ_DIVISOR = INDEX_SCALE * RATE_SCALER * MICROALGO_ROUNDS_PER_AQ
/** µxALGO·rounds × INDEX_SCALE for `xalgo` held `rounds` rounds. */
const held = (xalgo: bigint, rounds: number) => xalgo * BigInt(rounds) * INDEX_SCALE
/** An fxALGO amount dividing INDEX_SCALE: with it the pool index floors nothing, so see-through is exact. */
const F = 1_000_000_000n
const RESERVE_FX = 10n ** 16n

/**
 * Independent reference for the conserved total: ∫ circulating xALGO dt, where circulating is every
 * non-excluded holder's xALGO plus the pool's (the reserve is the only thing left out). Also reports
 * the largest fxALGO circulation seen, which bounds the index floor per step.
 */
function circulatingXalgoRounds(balances: BalanceMap, transfers: TaggedTransfer[], start: number, end: number) {
  const state = cloneBalances(balances)
  const circulating = () => {
    let sum = 0n
    for (const [address, b] of state) if (!isExcluded(address) || address === POOL) sum += b.xalgo
    return sum
  }
  let fxTotal = 0n
  for (const b of state.values()) fxTotal += b.fxalgo
  const fxCirculating = () => fxTotal - (state.get(POOL)?.fxalgo ?? 0n)
  let exact = 0n
  let maxFxCirculating = fxCirculating()
  let round = start
  for (const t of transfers) {
    exact += circulating() * BigInt(t.round - round) * INDEX_SCALE
    round = t.round
    applyTransfer(state, t, t.asset)
    if (fxCirculating() > maxFxCirculating) maxFxCirculating = fxCirculating()
  }
  exact += circulating() * BigInt(end - round) * INDEX_SCALE
  return { exact, maxFxCirculating }
}

describe('computeAttribution', () => {
  it('throws on non-monotonic rounds', () => {
    const balances = xalgoBalancesOf([ALICE, 1_000_000n, 0n])
    const transfers = [
      makeXalgoTagged('xalgo', { sender: ALICE, receiver: BOB, amount: 1n, round: 100 }),
      makeXalgoTagged('xalgo', { sender: ALICE, receiver: BOB, amount: 1n, round: 50 }),
    ]
    expect(() => computeAttribution(balances, transfers, 0, QUARTER, NO_ESCROWS)).toThrow(/Non-monotonic round/)
    expect(() => computeAttribution(xalgoBalancesOf(), [], 10, 5, NO_ESCROWS)).toThrow(/Non-monotonic round/)
  })

  it('earns nothing for a zero-balance account, the reserve, or the pool address', () => {
    const balances = xalgoBalancesOf(
      [ALICE, 1_000_000n, 0n],
      [BOB, 0n, 0n],
      [RESERVE, 10n ** 16n, 0n],
      [POOL, 5_000_000n, RESERVE_FX],
    )
    const { byBeneficiary, unattributed } = computeAttribution(balances, [], 0, QUARTER, NO_ESCROWS)
    expect(byBeneficiary.get(ALICE)).toBe(held(1_000_000n, QUARTER))
    expect(byBeneficiary.has(BOB)).toBe(false)
    expect(byBeneficiary.has(RESERVE)).toBe(false)
    expect(byBeneficiary.has(POOL)).toBe(false)
    // the pool's xALGO with nobody holding fxALGO is unattributed, not the pool's
    expect(unattributed).toBe(held(5_000_000n, QUARTER))
  })

  it('direct holding: a constant holder earns exactly xalgo × rounds × INDEX_SCALE', () => {
    const { byBeneficiary } = computeAttribution(
      xalgoBalancesOf([ALICE, 123_456_789n, 0n]),
      [],
      1_000,
      4_321,
      NO_ESCROWS,
    )
    expect(byBeneficiary.get(ALICE)).toBe(held(123_456_789n, 3_321))
  })

  it('conservation: Σ over all beneficiaries + unattributed == ∫ circulating xALGO dt, short by less than one fxALGO unit per step', () => {
    // Odd amounts everywhere so the index floors on every step; escrows, a borrower, a close-out, a mint from the reserve
    const balances = xalgoBalancesOf(
      [RESERVE, 10n ** 16n, 0n],
      [POOL, 777_777_777n, RESERVE_FX - 700_000_001n],
      [ALICE, 1_234_567n, 0n],
      [BOB, 98_765_431n, 300_000_001n],
      [ESCROW1, 0n, 400_000_000n],
    )
    const transfers = mergeAssetTransfers(
      [
        makeTransfer({ sender: RESERVE, receiver: CAROL, amount: 55_555_555n, round: 1_000, intraOffset: 1 }), // mint
        makeTransfer({ sender: POOL, receiver: CAROL, amount: 111_111_111n, round: 2_000, intraOffset: 0 }), // borrow
        makeTransfer({ sender: BOB, receiver: ALICE, amount: 33_333n, round: 2_000, intraOffset: 3 }),
        makeTransfer({ sender: ALICE, receiver: POOL, amount: 1_000_001n, round: 5_000, intraOffset: 0 }), // deposit (xALGO leg)
        makeTransfer({ sender: CAROL, receiver: POOL, amount: 50_000_000n, round: 7_000, intraOffset: 0 }), // repay
        makeTransfer({ sender: POOL, receiver: ESCROW2, amount: 100_000_003n, round: 9_000, intraOffset: 0 }), // withdraw (xALGO leg)
        makeTransfer({ sender: CAROL, receiver: BOB, amount: 1n, round: 12_345, intraOffset: 0, closeTo: ALICE }), // close-out
      ],
      [
        makeTransfer({ sender: POOL, receiver: ESCROW2, amount: 999_983n, round: 5_000, intraOffset: 0 }), // deposit (fxALGO leg)
        makeTransfer({ sender: ESCROW1, receiver: ESCROW2, amount: 123_456_789n, round: 6_000, intraOffset: 0 }), // liquidation-like move
        makeTransfer({ sender: ESCROW2, receiver: POOL, amount: 100_000_000n, round: 9_000, intraOffset: 0 }), // withdraw (fxALGO leg)
      ],
    )
    const start = 500
    const end = 20_000
    const { exact, maxFxCirculating } = circulatingXalgoRounds(balances, transfers, start, end)
    const { byBeneficiary, unattributed } = computeAttribution(
      cloneBalances(balances),
      transfers,
      start,
      end,
      escrowsOf(OWNER, ESCROW1, ESCROW2),
    )
    const attributed = sumValues(byBeneficiary) + unattributed

    expect(unattributed).toBe(0n)
    expect(attributed <= exact).toBe(true)
    // the only loss is the per-step floor of the index: < fxCirculating per step — and it is a real
    // loss, the amounts are chosen so the index floors on every step
    const steps = BigInt(new Set(transfers.map((t) => t.round)).size + 1)
    expect(exact - attributed > 0n).toBe(true)
    expect(exact - attributed < steps * maxFxCirculating).toBe(true)
    // and it is a real scenario: escrows folded away, the borrower credited, nobody excluded credited
    expect([...byBeneficiary.keys()].sort()).toEqual([ALICE, BOB, CAROL, OWNER].sort())
  })

  it('pool see-through: depositing X at round r then holding earns the same as holding X directly', () => {
    const X = 123_456_789_012n
    const direct = computeAttribution(xalgoBalancesOf([ALICE, X, 0n]), [], 0, QUARTER, NO_ESCROWS)
    const deposited = computeAttribution(
      xalgoBalancesOf([ALICE, X, 0n], [POOL, 0n, RESERVE_FX]),
      deposit(ALICE, X, F, 1_000_000),
      0,
      QUARTER,
      NO_ESCROWS,
    )
    expect(deposited.byBeneficiary.get(ALICE)).toBe(direct.byBeneficiary.get(ALICE))
    expect(deposited.byBeneficiary.get(ALICE)).toBe(held(X, QUARTER))
    expect(deposited.byBeneficiary.has(POOL)).toBe(false)
  })

  it('pro-rata: two depositors holding 2F and F split the pool xALGO·rounds 2:1', () => {
    const X = 3_000_000_000n
    const balances = xalgoBalancesOf([POOL, X, RESERVE_FX - 3n * F], [ALICE, 0n, 2n * F], [BOB, 0n, F])
    const { byBeneficiary, unattributed } = computeAttribution(balances, [], 0, QUARTER, NO_ESCROWS)
    expect(byBeneficiary.get(ALICE)).toBe(held(2_000_000_000n, QUARTER))
    expect(byBeneficiary.get(BOB)).toBe(held(1_000_000_000n, QUARTER))
    expect(unattributed).toBe(0n)
  })

  it('utilization: the pool lending half its xALGO halves the depositor share and credits the borrower the other half', () => {
    const X = 2_000_000_000n
    const balances = xalgoBalancesOf([POOL, X, RESERVE_FX - F], [ALICE, 0n, F])
    const borrow = [makeXalgoTagged('xalgo', { sender: POOL, receiver: BOB, amount: X / 2n, round: QUARTER })]
    const { byBeneficiary } = computeAttribution(balances, borrow, 0, 2 * QUARTER, NO_ESCROWS)
    expect(byBeneficiary.get(ALICE)).toBe(held(X, QUARTER) + held(X / 2n, QUARTER))
    expect(byBeneficiary.get(BOB)).toBe(held(X / 2n, QUARTER))
    expect(sumValues(byBeneficiary)).toBe(held(X, 2 * QUARTER))
  })

  it('a repayment restores the depositor share, and a withdrawal ends it', () => {
    const X = 4_000_000_000n
    const balances = xalgoBalancesOf([POOL, X, RESERVE_FX - F], [ALICE, 0n, F])
    const transfers = mergeAssetTransfers(
      [
        makeTransfer({ sender: POOL, receiver: BOB, amount: X / 4n, round: 1_000 }),
        makeTransfer({ sender: BOB, receiver: POOL, amount: X / 4n, round: 2_000 }),
      ],
      [],
    ).concat(withdraw(ALICE, F, X, 3_000))
    const { byBeneficiary } = computeAttribution(balances, transfers, 0, 4_000, NO_ESCROWS)
    // [0,1000) full pool, [1000,2000) three quarters of it, [2000,3000) full again, [3000,4000) held directly
    expect(byBeneficiary.get(ALICE)).toBe(held(X, 1_000) + held((3n * X) / 4n, 1_000) + held(X, 1_000) + held(X, 1_000))
    expect(byBeneficiary.get(BOB)).toBe(held(X / 4n, 1_000))
  })

  it('escrow attribution: fxALGO on two escrows of one owner lands on the owner, summed before flooring', () => {
    const X = 3_000_000n // 3 xALGO in the pool
    const balances = xalgoBalancesOf([POOL, X, RESERVE_FX - 2n * F], [ESCROW1, 0n, F], [ESCROW2, 0n, F])
    const { byBeneficiary } = computeAttribution(balances, [], 0, QUARTER, escrowsOf(OWNER, ESCROW1, ESCROW2))
    expect([...byBeneficiary.keys()]).toEqual([OWNER])
    expect(byBeneficiary.get(OWNER)).toBe(held(X, QUARTER))

    // single flooring: each escrow alone is worth 1.5 AQ at 1:1 → 1 each; together 3, not 2
    const aq = toAlgoQuarters(byBeneficiary, ONE_TO_ONE)
    expect(aq.get(OWNER)).toBe(3n)
    const separately = computeAttribution(
      xalgoBalancesOf([POOL, X, RESERVE_FX - 2n * F], [ESCROW1, 0n, F], [ESCROW2, 0n, F]),
      [],
      0,
      QUARTER,
      NO_ESCROWS,
    )
    const separateAq = toAlgoQuarters(separately.byBeneficiary, ONE_TO_ONE)
    expect(separateAq.get(ESCROW1)).toBe(1n)
    expect(separateAq.get(ESCROW2)).toBe(1n)
  })

  it('direct xALGO sitting on an escrow is credited to its owner too', () => {
    const balances = xalgoBalancesOf([ESCROW1, 7_000_000n, 0n], [OWNER, 1_000_000n, 0n])
    const { byBeneficiary } = computeAttribution(balances, [], 0, QUARTER, escrowsOf(OWNER, ESCROW1))
    expect(byBeneficiary.get(OWNER)).toBe(held(8_000_000n, QUARTER))
    expect(byBeneficiary.has(ESCROW1)).toBe(false)
  })

  it('fxCirculating == 0 with pool xALGO > 0: no throw, no division by zero, the residue stays unattributed', () => {
    const X = 5_000_000n
    // nobody holds fxALGO until ALICE deposits at QUARTER
    const balances = xalgoBalancesOf([POOL, X, RESERVE_FX], [ALICE, 1_000_000n, 0n])
    const { byBeneficiary, unattributed } = computeAttribution(
      balances,
      deposit(ALICE, 1_000_000n, F, QUARTER),
      0,
      2 * QUARTER,
      NO_ESCROWS,
    )
    expect(unattributed).toBe(held(X, QUARTER))
    // from QUARTER on, ALICE is the sole depositor and owns all of the pool's xALGO
    expect(byBeneficiary.get(ALICE)).toBe(held(1_000_000n, QUARTER) + held(X + 1_000_000n, QUARTER))
  })

  it('same-instant ordering is irrelevant: a deposit pair replayed xalgo-first vs fxalgo-first yields identical attribution', () => {
    const X = 999_999_999n
    const make = () => xalgoBalancesOf([ALICE, X, 0n], [BOB, 0n, F], [POOL, X, RESERVE_FX - F])
    const [xLeg, fxLeg] = deposit(ALICE, X, F, 1_234, 7)
    const a = computeAttribution(make(), [xLeg, fxLeg], 0, QUARTER, NO_ESCROWS)
    const b = computeAttribution(make(), [fxLeg, xLeg], 0, QUARTER, NO_ESCROWS)
    expect(a).toEqual(b)
    expect(a.byBeneficiary.get(ALICE)).toBe(held(X, 1_234) + held(X, QUARTER - 1_234))
    expect(a.byBeneficiary.get(BOB)).toBe(held(X, QUARTER))
  })

  it('a close-out accrues the sender up to the close and the closeTo party from it', () => {
    const balances = xalgoBalancesOf([ALICE, 1_000_000n, 0n])
    const transfers = [
      makeXalgoTagged('xalgo', { sender: ALICE, receiver: BOB, amount: 250_000n, round: 1_000, closeTo: CAROL }),
    ]
    const { byBeneficiary } = computeAttribution(balances, transfers, 0, 3_000, NO_ESCROWS)
    expect(byBeneficiary.get(ALICE)).toBe(held(1_000_000n, 1_000))
    expect(byBeneficiary.get(BOB)).toBe(held(250_000n, 2_000))
    expect(byBeneficiary.get(CAROL)).toBe(held(750_000n, 2_000))
  })

  it('splitting a window at a boundary preserves every beneficiary total', () => {
    const X = 2_000_000_000n
    const balances = xalgoBalancesOf(
      [POOL, X, RESERVE_FX - F],
      [ALICE, 5_000_000n, F],
      [BOB, 0n, 0n],
      [ESCROW1, 0n, 0n],
    )
    const transfers = mergeAssetTransfers(
      [
        makeTransfer({ sender: ALICE, receiver: BOB, amount: 1_000_000n, round: 400 }),
        makeTransfer({ sender: POOL, receiver: BOB, amount: X / 2n, round: 1_600 }),
      ],
      [makeTransfer({ sender: ALICE, receiver: ESCROW1, amount: F / 2n, round: 1_200 })],
    )
    const escrows = escrowsOf(OWNER, ESCROW1)
    const whole = computeAttribution(cloneBalances(balances), transfers, 0, 2_000, escrows)

    const first = computeAttribution(
      balances,
      transfers.filter((t) => t.round < 1_000),
      0,
      1_000,
      escrows,
    )
    const second = computeAttribution(
      balances,
      transfers.filter((t) => t.round >= 1_000),
      1_000,
      2_000,
      escrows,
    )
    for (const address of [ALICE, BOB, OWNER]) {
      expect((first.byBeneficiary.get(address) ?? 0n) + (second.byBeneficiary.get(address) ?? 0n)).toBe(
        whole.byBeneficiary.get(address),
      )
    }
    expect(first.unattributed + second.unattributed).toBe(whole.unattributed)
  })
})

describe('collectBeneficiaryCandidates', () => {
  it('covers holders of either asset at the window start and receivers of either inside it', () => {
    // ESCROW1 holds bare xALGO and touches no fxALGO all window — the PR-106 review case: it must
    // still be a candidate, or its accrual is credited to the un-votable escrow instead of OWNER
    const balances = xalgoBalancesOf([ESCROW1, 7_000_000n, 0n], [ALICE, 0n, F], [POOL, 5_000_000n, RESERVE_FX])
    const transfers: TaggedTransfer[] = [
      makeXalgoTagged('xalgo', { sender: ALICE, receiver: BOB, amount: 1n, round: 10 }),
      makeXalgoTagged('fxalgo', { sender: ALICE, receiver: CAROL, amount: 1n, round: 20, closeTo: ESCROW2 }),
    ]
    const candidates = collectBeneficiaryCandidates(balances, transfers)
    expect(candidates).toEqual(new Set([ESCROW1, ALICE, BOB, CAROL, ESCROW2]))
  })

  it('never nominates excluded addresses, as holder or receiver', () => {
    const balances = xalgoBalancesOf([POOL, 5_000_000n, RESERVE_FX], [RESERVE, 1_000_000n, 0n])
    const transfers: TaggedTransfer[] = [
      makeXalgoTagged('xalgo', { sender: ALICE, receiver: POOL, amount: 1n, round: 10, closeTo: RESERVE }),
    ]
    expect(collectBeneficiaryCandidates(balances, transfers)).toEqual(new Set())
  })

  it('zero-balance untouched addresses are not candidates', () => {
    const balances = xalgoBalancesOf([ALICE, 0n, 0n], [BOB, 1n, 0n])
    expect(collectBeneficiaryCandidates(balances, [])).toEqual(new Set([BOB]))
  })
})

describe('toAlgoQuarters', () => {
  it('1 xALGO held for 2 quarters at rate 1:1 → 2 AQ; at rate 1.5 → 3 AQ', () => {
    const attribution = new Map([[ALICE, held(1_000_000n, 2 * QUARTER)]])
    expect(toAlgoQuarters(attribution, ONE_TO_ONE).get(ALICE)).toBe(2n)
    expect(toAlgoQuarters(attribution, (RATE_SCALER * 3n) / 2n).get(ALICE)).toBe(3n)
  })

  it('floors once per beneficiary: result is the floor of the exact sum', () => {
    const rate = 1_222_515_991_456n
    const exact = held(987_654_321n, 1_234_567) + held(12_345n, 7_654_321)
    expect(toAlgoQuarters(new Map([[ALICE, exact]]), rate).get(ALICE)).toBe((exact * rate) / AQ_DIVISOR)
  })
})

describe('mergeAssetTransfers', () => {
  it('sorts strictly by (round, intraOffset) whatever the input order, preserving asset tags', () => {
    const merged = mergeAssetTransfers(
      [
        makeTransfer({ sender: ALICE, receiver: BOB, round: 5, intraOffset: 1 }),
        makeTransfer({ sender: ALICE, receiver: BOB, round: 2, intraOffset: 9 }),
      ],
      [
        makeTransfer({ sender: POOL, receiver: BOB, round: 5, intraOffset: 0 }),
        makeTransfer({ sender: POOL, receiver: BOB, round: 1, intraOffset: 0 }),
      ],
    )
    expect(merged.map((t) => [t.round, t.intraOffset, t.asset])).toEqual([
      [1, 0, 'fxalgo'],
      [2, 9, 'xalgo'],
      [5, 0, 'fxalgo'],
      [5, 1, 'xalgo'],
    ])
  })
})
