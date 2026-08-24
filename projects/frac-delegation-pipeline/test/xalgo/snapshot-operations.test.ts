/** Snapshot (de)serialization and comparison for the {xalgo, fxalgo} balance map. */

import { describe, it, expect } from 'vitest'

import {
  createSnapshot,
  deserializeBalances,
  diffBalances,
  diffSnapshot,
  getAllSnapshotBalances,
} from '../../src/plugins/xalgo/snapshot.ts'
import { ALICE, BOB, CAROL, POOL, RESERVE, xalgoBalancesOf } from './helpers.ts'

describe('createSnapshot', () => {
  it('drops all-zero balances and splits eligible from excluded (reserve, pool) addresses', () => {
    const balances = xalgoBalancesOf(
      [ALICE, 5n, 0n],
      [BOB, 0n, 0n],
      [CAROL, 0n, 7n],
      [RESERVE, 100n, 0n],
      [POOL, 9n, 800n],
    )
    const snapshot = createSnapshot(42n, balances)
    expect(snapshot.round).toBe(42)
    expect(snapshot.balances).toEqual({ [ALICE]: { xalgo: '5', fxalgo: '0' }, [CAROL]: { xalgo: '0', fxalgo: '7' } })
    expect(snapshot.excluded).toEqual({
      [RESERVE]: { xalgo: '100', fxalgo: '0' },
      [POOL]: { xalgo: '9', fxalgo: '800' },
    })
  })

  it('serializes addresses in codepoint order with both assets as decimal strings', () => {
    const snapshot = createSnapshot(1n, xalgoBalancesOf(['ZED', 1n, 1n], ['ann', 2n, 2n], ['Bob', 3n, 3n]))
    expect(Object.keys(snapshot.balances)).toEqual(['Bob', 'ZED', 'ann'])
    expect(snapshot.balances.ZED).toEqual({ xalgo: '1', fxalgo: '1' })
  })
})

describe('getAllSnapshotBalances', () => {
  it('round-trips the non-zero entries of the original map, eligible and excluded merged', () => {
    const original = xalgoBalancesOf([ALICE, 5n, 6n], [BOB, 0n, 0n], [POOL, 9n, 800n])
    const roundTripped = getAllSnapshotBalances(createSnapshot(7n, original))
    expect(roundTripped).toEqual(xalgoBalancesOf([ALICE, 5n, 6n], [POOL, 9n, 800n]))
    expect(deserializeBalances({ [ALICE]: { xalgo: '5', fxalgo: '6' } })).toEqual(xalgoBalancesOf([ALICE, 5n, 6n]))
  })
})

describe('diffSnapshot', () => {
  const stored = createSnapshot(1n, xalgoBalancesOf([ALICE, 5n, 6n], [BOB, 7n, 0n], [POOL, 9n, 800n]))

  it('reports one diff per mutated balance, per asset', () => {
    const diffs = diffSnapshot(xalgoBalancesOf([ALICE, 5n, 1n], [BOB, 8n, 0n], [POOL, 9n, 800n]), stored)
    expect(diffs).toHaveLength(2)
    expect(diffs[0]).toContain(`${ALICE}  fxalgo 6→1`)
    expect(diffs[1]).toContain(`${BOB}  xalgo 7→8`)
  })

  it('detects missing and extra addresses', () => {
    const diffs = diffBalances(
      xalgoBalancesOf([ALICE, 5n, 6n], [CAROL, 1n, 0n], [POOL, 9n, 800n]),
      getAllSnapshotBalances(stored),
    )
    expect(diffs.map((d) => d.trim().split(/\s+/)[1])).toEqual([BOB, CAROL].sort())
  })

  it('is empty for a snapshot of the same balances', () => {
    expect(diffSnapshot(xalgoBalancesOf([ALICE, 5n, 6n], [BOB, 7n, 0n], [POOL, 9n, 800n]), stored)).toEqual([])
  })
})
