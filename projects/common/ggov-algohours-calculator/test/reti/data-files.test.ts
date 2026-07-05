/** Self-consistency and cross-file checks for the committed algohours artifacts in data/reti/. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PROTOCOL } from '../../src/reti/constants'
import { getSnapshotPath, readSnapshot } from '../../src/reti/snapshot/operations'
import type { AlgoHoursData } from '../../src/types'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'data', 'reti')
const TINYMAN_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'data', 'tinyman')
const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')) : []
const datasets = files.map((file) => ({
  file,
  data: JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as AlgoHoursData,
}))

describe('reti data files', () => {
  it.skipIf(files.length > 0)('no committed data files to validate', () => {})

  for (const { file, data } of datasets) {
    describe(file, () => {
      const startSnapshotExists = existsSync(getSnapshotPath(data.periodStart))
      const endSnapshotExists = existsSync(getSnapshotPath(data.periodEnd))
      const tinymanTwin = join(TINYMAN_DATA_DIR, file)

      it('has consistent metadata and no rate', () => {
        expect(data.networkGenesisHash).toMatch(/^[A-Za-z0-9+/]{43}=$/)
        expect(data.protocol).toBe(PROTOCOL)
        expect('rate' in data).toBe(false)
        expect(data.periodStart).toBeLessThan(data.periodEnd)
        expect(data.periodStartTime).toBeLessThan(data.periodEndTime)
        expect(file).toBe(`${data.periodStart}-${data.periodEnd}.json`)
      })

      it('totals match the account list', () => {
        expect(data.totalAccounts).toBe(data.accounts.length)
        const summed = data.accounts.reduce((sum, account) => sum + BigInt(account.algoHours), 0n)
        expect(summed.toString()).toBe(data.totalAlgoHours)
      })

      it('accounts are strictly ascending by codepoint with positive algohours', () => {
        for (let i = 0; i < data.accounts.length; i++) {
          const { account, algoHours } = data.accounts[i]
          if (i > 0) expect(data.accounts[i - 1].account < account).toBe(true)
          expect(BigInt(algoHours)).toBeGreaterThan(0n)
        }
      })

      it.skipIf(!startSnapshotExists || !endSnapshotExists)('period timestamps match the boundary snapshots', () => {
        expect(data.periodStartTime).toBe(readSnapshot(data.periodStart).timestamp)
        expect(data.periodEndTime).toBe(readSnapshot(data.periodEnd).timestamp)
      })

      it.skipIf(!existsSync(tinymanTwin))('period timestamps match the tinyman file for the same window', () => {
        const twin = JSON.parse(readFileSync(tinymanTwin, 'utf-8')) as AlgoHoursData
        expect(data.periodStartTime).toBe(twin.periodStartTime)
        expect(data.periodEndTime).toBe(twin.periodEndTime)
      })
    })
  }
})
