/** Self-consistency and cross-file checks for the committed algohours artifacts in data/. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PROTOCOL, RATE_SCALER } from '../../src/tinyman/constants'
import { isExcluded } from '../../src/tinyman/exclusions'
import { totalSupply } from '../../src/tinyman/ledger'
import {
  deserializeBalances,
  getAllSnapshotBalances,
  getSnapshotPath,
  readSnapshot,
} from '../../src/tinyman/snapshot/operations'
import type { AlgoHoursData } from '../../src/types'

// Tinyman files always carry the tALGO/ALGO rate
type TinymanAlgoHoursData = AlgoHoursData & { rate: string }

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'data', 'tinyman')
const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')) : []
const datasets = files.map((file) => ({
  file,
  data: JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as TinymanAlgoHoursData,
}))

function scaledRate(rate: string): bigint {
  return BigInt(rate.replace('.', ''))
}

describe('data files', () => {
  for (const { file, data } of datasets) {
    describe(file, () => {
      const startSnapshotExists = existsSync(getSnapshotPath(data.periodStart))
      const endSnapshotExists = existsSync(getSnapshotPath(data.periodEnd))

      it('has consistent metadata', () => {
        expect(data.networkGenesisHash).toMatch(/^[A-Za-z0-9+/]{43}=$/)
        expect(data.protocol).toBe(PROTOCOL)
        expect(data.rate).toMatch(/^\d+\.\d{12}$/)
        expect(data.periodStart).toBeLessThan(data.periodEnd)
        expect(data.periodStartTime).toBeLessThan(data.periodEndTime)
        expect(file).toBe(`${data.periodStart}-${data.periodEnd}.json`)
      })

      it('totals match the account list', () => {
        expect(data.totalAccounts).toBe(data.accounts.length)
        const summed = data.accounts.reduce((sum, account) => sum + BigInt(account.algoHours), 0n)
        expect(summed.toString()).toBe(data.totalAlgoHours)
      })

      it('accounts are strictly ascending by codepoint with positive algohours, none excluded', () => {
        for (let i = 0; i < data.accounts.length; i++) {
          const { account, algoHours } = data.accounts[i]
          if (i > 0) expect(data.accounts[i - 1].account < account).toBe(true)
          expect(BigInt(algoHours)).toBeGreaterThan(0n)
          expect(isExcluded(account)).toBe(false)
        }
      })

      it.skipIf(!startSnapshotExists || !endSnapshotExists)('period timestamps match the boundary snapshots', () => {
        expect(data.periodStartTime).toBe(readSnapshot(data.periodStart).timestamp)
        expect(data.periodEndTime).toBe(readSnapshot(data.periodEnd).timestamp)
      })

      // Local-only: the transfer log is a gitignored artifact of `algohours:tinyman
      // --save-transfers`, so this check skips wherever the log is absent (e.g. CI)
      const transfersLog = join(DATA_DIR, `${data.periodStart}-${data.periodEnd}.transfers.log`)
      it.skipIf(!startSnapshotExists || !existsSync(transfersLog))(
        'accounts untouched by transfers earn exactly balance × rate × duration',
        () => {
          // Independent per-account recomputation: an account absent from the window's transfer
          // log held a constant balance, so its algohours are a single multiplication
          const touched = new Set<string>()
          for (const [address] of readFileSync(transfersLog, 'utf-8').matchAll(/[A-Z2-7]{58}/g)) touched.add(address)

          const fileAlgoHours = new Map(data.accounts.map(({ account, algoHours }) => [account, BigInt(algoHours)]))
          const duration = BigInt(data.periodEndTime - data.periodStartTime)
          let untouched = 0
          for (const [account, { talgo, stalgo }] of deserializeBalances(readSnapshot(data.periodStart).balances)) {
            if (touched.has(account)) continue
            untouched++
            const expected = ((talgo + stalgo) * scaledRate(data.rate) * duration) / (RATE_SCALER * 3600n)
            expect(fileAlgoHours.get(account) ?? 0n, account).toBe(expected)
          }
          expect(untouched).toBeGreaterThan(0)
        },
      )

      it.skipIf(!startSnapshotExists)('totalAlgoHours never exceeds supply × rate × duration', () => {
        const supply = totalSupply(getAllSnapshotBalances(readSnapshot(data.periodStart)))
        const duration = BigInt(data.periodEndTime - data.periodStartTime)
        const upperBound = ((supply.talgo + supply.stalgo) * scaledRate(data.rate) * duration) / (RATE_SCALER * 3600n)
        expect(BigInt(data.totalAlgoHours)).toBeLessThanOrEqual(upperBound)
      })
    })
  }

  describe.skipIf(datasets.length < 2)('across data files', () => {
    it('rates strictly increase with periodStart (staking rewards only accrue)', () => {
      const sorted = [...datasets].sort((a, b) => a.data.periodStart - b.data.periodStart)
      for (let i = 1; i < sorted.length; i++) {
        expect(scaledRate(sorted[i].data.rate)).toBeGreaterThan(scaledRate(sorted[i - 1].data.rate))
      }
    })
  })
})
