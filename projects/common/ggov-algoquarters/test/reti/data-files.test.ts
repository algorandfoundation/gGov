/** Self-consistency and snapshot/event-anchored checks for the committed algoquarter artifacts in data/reti/. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PROTOCOL } from '../../src/reti/constants'
import { getSnapshotPath, readSnapshot } from '../../src/reti/snapshot/operations'
import { MICROALGO_ROUNDS_PER_AQ } from '../../src/utils/aq'
import { expectAlgoQuarterTotals, expectSortedPositiveUint32AlgoQuarters, readJsonLines } from '../helpers'
import type { RetiSnapshotData } from '../../src/reti/types'
import type { AlgoQuartersData } from '../../src/types'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'data', 'reti')
const SNAPSHOTS_DIR = dirname(getSnapshotPath(0))
const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')) : []
const datasets = files.map((file) => ({
  file,
  data: JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as AlgoQuartersData,
}))
const snapshotRounds = (existsSync(SNAPSHOTS_DIR) ? readdirSync(SNAPSHOTS_DIR) : [])
  .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
  .filter((round) => round !== undefined)
  .map(Number)

// One line per event as written by `algoquarters:reti --save-events`
type LoggedEvent =
  | { type: 'stakeAdded'; round: number; staker: string; amount: string }
  | { type: 'stakeRemoved'; round: number; staker: string; amount: string }
  | { type: 'epochRewardUpdate'; round: number; algoAdded: string }

function stakeAndStakers(snapshot: RetiSnapshotData): { stake: bigint; stakers: Set<string> } {
  let stake = 0n
  const stakers = new Set<string>()
  for (const pool of Object.values(snapshot.pools)) {
    for (const [staker, { balance }] of Object.entries(pool)) {
      stake += BigInt(balance)
      stakers.add(staker)
    }
  }
  return { stake, stakers }
}

describe('reti data files', () => {
  for (const { file, data } of datasets) {
    describe(file, () => {
      it('has consistent metadata and no rate', () => {
        expect(data.networkGenesisHash).toMatch(/^[A-Za-z0-9+/]{43}=$/)
        expect(data.protocol).toBe(PROTOCOL)
        expect('rate' in data).toBe(false)
        expect(data.periodStart).toBeLessThan(data.periodEnd)
        expect(file).toBe(`${data.periodStart}-${data.periodEnd}.json`)
      })

      it('totals match the account list', () => {
        expectAlgoQuarterTotals(data)
      })

      it('accounts are strictly ascending by codepoint with positive integer algoquarters', () => {
        expectSortedPositiveUint32AlgoQuarters(data.accounts)
      })

      // Local-only: the events log is a gitignored artifact of `algoquarters:reti
      // --save-events`, so this check skips wherever the log is absent (e.g. CI)
      const eventsLog = join(DATA_DIR, `${data.periodStart}-${data.periodEnd}.events.log`)
      it.skipIf(!existsSync(getSnapshotPath(data.periodStart)) || !existsSync(eventsLog))(
        'totalAlgoQuarters equals the integral of total stake over the events, within per-account flooring',
        () => {
          // Independent totalization: fold the raw event amounts into ∫ total-stake d(round),
          // never touching the per-account reward-splitting logic
          const { stake, stakers } = stakeAndStakers(readSnapshot(data.periodStart))
          const events = readJsonLines<LoggedEvent>(eventsLog)

          let total = stake
          let microAlgoRounds = 0n
          let last = data.periodStart
          for (const event of events) {
            microAlgoRounds += total * BigInt(event.round - last)
            last = event.round
            if (event.type === 'stakeAdded') {
              total += BigInt(event.amount)
              stakers.add(event.staker)
            } else if (event.type === 'stakeRemoved') total -= BigInt(event.amount)
            else total += BigInt(event.algoAdded)
          }
          microAlgoRounds += total * BigInt(data.periodEnd - last)

          // Each participant's floor loses < 1 AQ, and omitting sub-1 AQ accounts loses their floor of 0
          const exactTotal = microAlgoRounds / MICROALGO_ROUNDS_PER_AQ
          expect(BigInt(data.totalAlgoQuarters)).toBeLessThanOrEqual(exactTotal)
          expect(exactTotal - BigInt(data.totalAlgoQuarters)).toBeLessThan(BigInt(stakers.size))
        },
      )

      const boundaryRounds = snapshotRounds.filter((round) => round >= data.periodStart && round <= data.periodEnd)
      it.skipIf(boundaryRounds.length === 0)(
        'totalAlgoQuarters is commensurate with the boundary-snapshot stake',
        () => {
          // Coarse magnitude check against the committed snapshots: stake moves slowly, so the
          // window integral must sit within 2× of stake × duration at every boundary. Catches
          // regenerated files with a wrong unit or divisor that are still internally consistent.
          const stakes = boundaryRounds.map((round) => stakeAndStakers(readSnapshot(round)).stake)
          const duration = BigInt(data.periodEnd - data.periodStart)
          const total = BigInt(data.totalAlgoQuarters)
          const minStake = stakes.reduce((min, stake) => (stake < min ? stake : min))
          const maxStake = stakes.reduce((max, stake) => (stake > max ? stake : max))
          expect(total).toBeGreaterThanOrEqual((minStake * duration) / (2n * MICROALGO_ROUNDS_PER_AQ))
          expect(total).toBeLessThanOrEqual((2n * maxStake * duration) / MICROALGO_ROUNDS_PER_AQ)
        },
      )
    })
  }
})
