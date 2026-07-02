/** Balance replay invariants: supply conservation, close-out semantics, fail-loud guards. */

import { describe, it, expect } from 'vitest'

import { applyTransfer, totalSupply } from '../src/ledger'
import { ALICE, BOB, CAROL, balancesOf, makeTransfer } from './helpers'

describe('applyTransfer', () => {
  it('throws when a transfer overspends the sender balance', () => {
    const balances = balancesOf([ALICE, 10n, 0n])
    expect(() => applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 11n }), 'talgo')).toThrow(
      /Negative talgo balance/,
    )
  })

  it('throws when closeAmount disagrees with the computed remainder', () => {
    const balances = balancesOf([ALICE, 10n, 0n])
    const transfer = makeTransfer({ sender: ALICE, receiver: BOB, amount: 4n, closeTo: CAROL, closeAmount: 5n })
    expect(() => applyTransfer(balances, transfer, 'talgo')).toThrow(/Close-out talgo mismatch/)
  })

  it('registers an opt-in without moving any balance', () => {
    const balances = balancesOf([ALICE, 10n, 0n])
    applyTransfer(balances, makeTransfer({ sender: BOB, receiver: BOB, amount: 0n }), 'talgo')

    expect(balances.get(BOB)).toEqual({ talgo: 0n, stalgo: 0n })
    expect(totalSupply(balances)).toEqual({ talgo: 10n, stalgo: 0n })
  })

  it('moves the remainder to closeTo and zeroes the sender on close-out', () => {
    const balances = balancesOf([ALICE, 10n, 0n])
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 4n, closeTo: CAROL }), 'talgo')

    expect(balances.get(ALICE)).toEqual({ talgo: 0n, stalgo: 0n })
    expect(balances.get(BOB)).toEqual({ talgo: 4n, stalgo: 0n })
    expect(balances.get(CAROL)).toEqual({ talgo: 6n, stalgo: 0n })
  })

  it('conserves total supply across transfers, clawbacks, close-outs and opt-ins', () => {
    const balances = balancesOf([ALICE, 100n, 20n], [BOB, 50n, 0n])
    const initial = totalSupply(balances)

    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 30n }), 'talgo')
    // Clawback: indexer.ts maps the clawback source to `sender`, so it replays as a regular transfer
    applyTransfer(balances, makeTransfer({ sender: BOB, receiver: CAROL, amount: 10n }), 'talgo')
    applyTransfer(balances, makeTransfer({ sender: CAROL, receiver: CAROL, amount: 0n }), 'stalgo')
    applyTransfer(balances, makeTransfer({ sender: ALICE, receiver: BOB, amount: 5n, closeTo: CAROL }), 'stalgo')

    expect(totalSupply(balances)).toEqual(initial)
  })
})
