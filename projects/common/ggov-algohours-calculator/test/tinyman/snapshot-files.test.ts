/** Self-consistency and cross-file checks for the committed snapshots in snapshots/. */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { isExcluded } from '../../src/tinyman/exclusions'
import { totalSupply } from '../../src/tinyman/ledger'
import { getAllSnapshotBalances, readSnapshot } from '../../src/tinyman/snapshot/operations'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'snapshots', 'tinyman')
const rounds = existsSync(SNAPSHOTS_DIR)
  ? readdirSync(SNAPSHOTS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.replace('.json', '')))
      .sort((a, b) => a - b)
  : []
const snapshots = rounds.map((round) => readSnapshot(round))

describe('snapshot files', () => {
  it.skipIf(rounds.length > 0)('no committed snapshots to validate', () => {})

  for (const snapshot of snapshots) {
    describe(`${snapshot.round}.json`, () => {
      it('addresses are strictly ascending with non-zero decimal balances', () => {
        for (const section of [snapshot.balances, snapshot.excluded]) {
          const addresses = Object.keys(section)
          for (let i = 0; i < addresses.length; i++) {
            if (i > 0) expect(addresses[i - 1] < addresses[i]).toBe(true)
            const { talgo, stalgo } = section[addresses[i]]
            expect(talgo).toMatch(/^\d+$/)
            expect(stalgo).toMatch(/^\d+$/)
            expect(talgo === '0' && stalgo === '0').toBe(false)
          }
        }
      })

      it('eligible/excluded split matches exclusions.ts', () => {
        for (const address of Object.keys(snapshot.balances)) expect(isExcluded(address)).toBe(false)
        for (const address of Object.keys(snapshot.excluded)) expect(isExcluded(address)).toBe(true)
      })
    })
  }

  describe.skipIf(rounds.length < 2)('across snapshots', () => {
    it('total supply is identical in every snapshot', () => {
      const supplies = snapshots.map((snapshot) => totalSupply(getAllSnapshotBalances(snapshot)))
      for (const supply of supplies.slice(1)) expect(supply).toEqual(supplies[0])
    })

    it('timestamps strictly increase with round', () => {
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i - 1].round).toBeLessThan(snapshots[i].round)
        expect(snapshots[i - 1].timestamp).toBeLessThan(snapshots[i].timestamp)
      }
    })
  })
})
