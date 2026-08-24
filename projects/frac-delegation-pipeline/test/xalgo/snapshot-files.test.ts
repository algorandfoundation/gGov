/** Self-consistency and cross-file checks for the committed snapshots in snapshots/xalgo/. */

import { existsSync, readdirSync } from 'node:fs'

import { describe, it, expect } from 'vitest'

import { XALGO_APP_ADDRESS, XALGO_POOL_ADDRESS } from '../../src/plugins/xalgo/constants.ts'
import { isExcluded } from '../../src/plugins/xalgo/exclusions.ts'
import { totalSupply } from '../../src/plugins/xalgo/ledger.ts'
import {
  DEFAULT_SNAPSHOTS_DIR,
  createXalgoSnapshotStore,
  getAllSnapshotBalances,
} from '../../src/plugins/xalgo/snapshot.ts'

const { readSnapshot } = createXalgoSnapshotStore()
const SNAPSHOTS_DIR = DEFAULT_SNAPSHOTS_DIR
// `beneficiaries.json` lives in the same directory: only `<round>.json` are snapshots
const rounds = existsSync(SNAPSHOTS_DIR)
  ? readdirSync(SNAPSHOTS_DIR)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.replace('.json', '')))
      .sort((a, b) => a - b)
  : []
const snapshots = rounds.map((round) => readSnapshot(round))

describe('snapshot files', () => {
  for (const snapshot of snapshots) {
    describe(`${snapshot.round}.json`, () => {
      it('addresses are strictly ascending with non-zero decimal balances', () => {
        for (const section of [snapshot.balances, snapshot.excluded]) {
          const addresses = Object.keys(section)
          for (let i = 0; i < addresses.length; i++) {
            if (i > 0) expect(addresses[i - 1] < addresses[i]).toBe(true)
            const { xalgo, fxalgo } = section[addresses[i]]
            expect(xalgo).toMatch(/^\d+$/)
            expect(fxalgo).toMatch(/^\d+$/)
            expect(xalgo === '0' && fxalgo === '0').toBe(false)
          }
        }
      })

      it('eligible/excluded split matches exclusions.ts', () => {
        for (const address of Object.keys(snapshot.balances)) expect(isExcluded(address)).toBe(false)
        for (const address of Object.keys(snapshot.excluded)) expect(isExcluded(address)).toBe(true)
      })

      it('the reserves hold the un-minted supply and the pool holds the deposited xALGO', () => {
        // xALGO: the consensus app is the reserve; fxALGO: the pool is
        expect(BigInt(snapshot.excluded[XALGO_APP_ADDRESS].xalgo) > 0n).toBe(true)
        expect(snapshot.excluded[XALGO_APP_ADDRESS].fxalgo).toBe('0')
        expect(BigInt(snapshot.excluded[XALGO_POOL_ADDRESS].fxalgo) > 0n).toBe(true)
        expect(BigInt(snapshot.excluded[XALGO_POOL_ADDRESS].xalgo) > 0n).toBe(true)
      })
    })
  }

  describe.skipIf(rounds.length < 2)('across snapshots', () => {
    it('total supply of both assets is identical in every snapshot', () => {
      const supplies = snapshots.map((snapshot) => totalSupply(getAllSnapshotBalances(snapshot)))
      for (const supply of supplies.slice(1)) expect(supply).toEqual(supplies[0])
    })
  })
})
