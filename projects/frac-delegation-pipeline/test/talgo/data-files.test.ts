/** Self-consistency and cross-file checks for the committed algoquarter artifacts in data/. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PROTOCOL, RATE_SCALER } from '../../src/plugins/talgo/constants.ts'
import { isExcluded } from '../../src/plugins/talgo/exclusions.ts'
import { totalSupply } from '../../src/plugins/talgo/ledger.ts'
import { MICROALGO_ROUNDS_PER_AQ } from '../../src/aq/index.ts'
import {
  createTalgoSnapshotStore,
  deserializeBalances,
  getAllSnapshotBalances,
} from '../../src/plugins/talgo/snapshot.ts'
import { expectAlgoQuarterTotals, expectSortedPositiveUint32AlgoQuarters } from '../helpers.ts'
import type { AlgoQuartersData } from '../../src/aq/index.ts'

// Tinyman files always carry the tALGO/ALGO rate
type TinymanAlgoQuartersData = AlgoQuartersData & { rate: string }

const { getSnapshotPath, readSnapshot } = createTalgoSnapshotStore()

// Archive of the windows the retired `algoquarters:tinyman` CLI produced. The plugin computes in
// memory and never writes here, so these are a fixed record — and the reference these invariants
// are checked against.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'data', 'talgo')
const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')) : []
const datasets = files.map((file) => ({
  file,
  data: JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as TinymanAlgoQuartersData,
}))

function scaledRate(rate: string): bigint {
  return BigInt(rate.replace('.', ''))
}

describe('data files', () => {
  for (const { file, data } of datasets) {
    describe(file, () => {
      const startSnapshotExists = existsSync(getSnapshotPath(data.periodStart))

      it('has consistent metadata', () => {
        expect(data.networkGenesisHash).toMatch(/^[A-Za-z0-9+/]{43}=$/)
        expect(data.protocol).toBe(PROTOCOL)
        expect(data.rate).toMatch(/^\d+\.\d{12}$/)
        expect(data.periodStart).toBeLessThan(data.periodEnd)
        expect(file).toBe(`${data.periodStart}-${data.periodEnd}.json`)
      })

      it('totals match the account list', () => {
        expectAlgoQuarterTotals(data)
      })

      it('accounts are strictly ascending by codepoint with positive integer algoquarters, none excluded', () => {
        expectSortedPositiveUint32AlgoQuarters(data.accounts, { isExcluded })
      })

      // Local-only: the transfer log is a gitignored artifact of `algoquarters:tinyman
      // --save-transfers`, so this check skips wherever the log is absent (e.g. CI)
      const transfersLog = join(DATA_DIR, `${data.periodStart}-${data.periodEnd}.transfers.log`)
      it.skipIf(!startSnapshotExists || !existsSync(transfersLog))(
        'accounts untouched by transfers earn exactly balance × rate × duration',
        () => {
          // Independent per-account recomputation: an account absent from the window's transfer
          // log held a constant balance, so its algoquarters are a single multiplication
          const touched = new Set<string>()
          for (const [address] of readFileSync(transfersLog, 'utf-8').matchAll(/[A-Z2-7]{58}/g)) touched.add(address)

          const fileAlgoQuarters = new Map(
            data.accounts.map(({ account, algoQuarters }) => [account, BigInt(algoQuarters)]),
          )
          const duration = BigInt(data.periodEnd - data.periodStart)
          let untouched = 0
          for (const [account, { talgo, stalgo }] of deserializeBalances(readSnapshot(data.periodStart).balances)) {
            if (touched.has(account)) continue
            untouched++
            // Sub-1 AQ accounts are omitted from the file, so a missing account must floor to 0
            const expected =
              ((talgo + stalgo) * scaledRate(data.rate) * duration) / (RATE_SCALER * MICROALGO_ROUNDS_PER_AQ)
            expect(fileAlgoQuarters.get(account) ?? 0n, account).toBe(expected)
          }
          expect(untouched).toBeGreaterThan(0)
        },
      )

      it.skipIf(!startSnapshotExists)('totalAlgoQuarters never exceeds supply × rate × duration', () => {
        const supply = totalSupply(getAllSnapshotBalances(readSnapshot(data.periodStart)))
        const duration = BigInt(data.periodEnd - data.periodStart)
        const upperBound =
          ((supply.talgo + supply.stalgo) * scaledRate(data.rate) * duration) / (RATE_SCALER * MICROALGO_ROUNDS_PER_AQ)
        expect(BigInt(data.totalAlgoQuarters)).toBeLessThanOrEqual(upperBound)
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
