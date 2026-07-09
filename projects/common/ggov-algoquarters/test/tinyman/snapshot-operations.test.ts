/** Snapshot round-trips: serialization, eligible/excluded split, diff detection. */

import { describe, it, expect } from 'vitest'

import { TALGO_APP_ADDRESS } from '../../src/tinyman/constants'
import { createSnapshot, diffSnapshot, getAllSnapshotBalances } from '../../src/tinyman/snapshot/operations'
import { ALICE, BOB, CAROL, balancesOf } from '../helpers'

describe('createSnapshot', () => {
  it('drops zero balances and splits eligible from excluded addresses', () => {
    const balances = balancesOf([BOB, 5n, 0n], [ALICE, 10n, 20n], [CAROL, 0n, 0n], [TALGO_APP_ADDRESS, 1_000_000n, 0n])
    const snapshot = createSnapshot(123n, balances)

    expect(snapshot.round).toBe(123)
    expect(snapshot.balances).toEqual({ ALICE: { talgo: '10', stalgo: '20' }, BOB: { talgo: '5', stalgo: '0' } })
    expect(snapshot.excluded).toEqual({ [TALGO_APP_ADDRESS]: { talgo: '1000000', stalgo: '0' } })
  })

  it('serializes addresses in codepoint order', () => {
    const snapshot = createSnapshot(1n, balancesOf(['B2', 1n, 0n], ['A7', 1n, 0n], ['AB', 1n, 0n]))
    expect(Object.keys(snapshot.balances)).toEqual(['A7', 'AB', 'B2'])
  })
})

describe('getAllSnapshotBalances', () => {
  it('round-trips the non-zero entries of the original map, eligible and excluded merged', () => {
    const original = balancesOf([ALICE, 10n, 20n], [TALGO_APP_ADDRESS, 7n, 0n], [CAROL, 0n, 0n])
    const recovered = getAllSnapshotBalances(createSnapshot(1n, original))

    expect(recovered.get(ALICE)).toEqual({ talgo: 10n, stalgo: 20n })
    expect(recovered.get(TALGO_APP_ADDRESS)).toEqual({ talgo: 7n, stalgo: 0n })
    expect(recovered.has(CAROL)).toBe(false)
  })
})

describe('diffSnapshot', () => {
  const balances = balancesOf([ALICE, 10n, 20n], [BOB, 5n, 0n])
  const stored = createSnapshot(1n, balances)

  it('reports one diff per mutated balance', () => {
    const mutated = balancesOf([ALICE, 11n, 19n], [BOB, 5n, 0n])
    const diffs = diffSnapshot(mutated, stored)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toContain(ALICE)
  })

  it('detects missing and extra addresses', () => {
    expect(diffSnapshot(balancesOf([ALICE, 10n, 20n]), stored)).toHaveLength(1)
    expect(diffSnapshot(balancesOf([ALICE, 10n, 20n], [BOB, 5n, 0n], [CAROL, 1n, 0n]), stored)).toHaveLength(1)
  })

  it('is empty for a snapshot of the same balances', () => {
    expect(diffSnapshot(balances, stored)).toEqual([])
  })
})
