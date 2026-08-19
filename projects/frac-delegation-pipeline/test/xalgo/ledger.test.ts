/** Ledger replay over the {xalgo, fxalgo} balance map — test/talgo/ledger.test.ts for two assets. */

import { describe, it, expect } from 'vitest'

import { applyTransfer, totalSupply } from '../../src/plugins/xalgo/ledger.ts'
import { ALICE, BOB, CAROL, POOL, deposit, makeTransfer, xalgoBalancesOf } from './helpers.ts'

describe('applyTransfer', () => {
  it('throws when a transfer overspends the sender balance', () => {
    const balances = xalgoBalancesOf([ALICE, 100n, 0n])
    expect(() =>
      applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 101n }), 'xalgo'),
    ).toThrow(/Negative xalgo balance/)
    // the other asset is untouched by the failed transfer on this one
    expect(() => applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 1n }), 'fxalgo')).toThrow(
      /Negative fxalgo balance/,
    )
  })

  it('throws when closeAmount disagrees with the computed remainder', () => {
    const balances = xalgoBalancesOf([ALICE, 100n, 0n])
    const transfer = makeTransfer({ sender: ALICE, receiver: BOB, amount: 10n, closeTo: CAROL, closeAmount: 5n })
    expect(() => applyTransfer(balances, transfer, 'xalgo')).toThrow(/Close-out xalgo mismatch/)
  })

  it('registers an opt-in without moving any balance', () => {
    const balances = xalgoBalancesOf()
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: ALICE, amount: 0n }), 'fxalgo')
    expect(balances.get(ALICE)).toEqual({ xalgo: 0n, fxalgo: 0n })
  })

  it('moves the remainder to closeTo and zeroes the sender on close-out', () => {
    const balances = xalgoBalancesOf([ALICE, 100n, 7n])
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 30n, closeTo: CAROL }), 'xalgo')
    expect(balances.get(ALICE)).toEqual({ xalgo: 0n, fxalgo: 7n })
    expect(balances.get(BOB)?.xalgo).toBe(30n)
    expect(balances.get(CAROL)?.xalgo).toBe(70n)
  })

  it('conserves total supply of each asset across transfers, close-outs and opt-ins', () => {
    const balances = xalgoBalancesOf([ALICE, 1_000n, 500n], [BOB, 0n, 20n])
    const before = totalSupply(balances)
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 400n }), 'xalgo')
    applyTransfer(balances, makeTransfer({ sender: BOB, receiver: BOB, amount: 0n }), 'xalgo')
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: CAROL, amount: 100n, closeTo: BOB }), 'fxalgo')
    applyTransfer(balances, makeTransfer({ sender: BOB, receiver: CAROL, amount: 1n, closeTo: ALICE }), 'xalgo')
    expect(totalSupply(balances)).toEqual(before)
    expect(before).toEqual({ xalgo: 1_000n, fxalgo: 520n })
  })

  it('a pool deposit moves xalgo to the pool and fxalgo out of the pool reserve, leaving both totals unchanged', () => {
    const balances = xalgoBalancesOf([ALICE, 1_000n, 0n], [POOL, 0n, 10_000n])
    for (const t of deposit(ALICE, 400n, 399n, 10)) applyTransfer(balances, t, t.asset)
    expect(balances.get(ALICE)).toEqual({ xalgo: 600n, fxalgo: 399n })
    expect(balances.get(POOL)).toEqual({ xalgo: 400n, fxalgo: 9_601n })
    expect(totalSupply(balances)).toEqual({ xalgo: 1_000n, fxalgo: 10_000n })
  })
})
