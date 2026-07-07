/** Structural checks for the committed pool snapshots in snapshots/reti/. */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { RETI_APP_CREATION_ROUND, STAKING_BLOCK_DELAY } from '../../src/reti/constants'
import { readSnapshot } from '../../src/reti/snapshot/operations'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..', 'snapshots', 'reti')
const rounds = existsSync(SNAPSHOTS_DIR)
  ? readdirSync(SNAPSHOTS_DIR)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.replace('.json', '')))
      .sort((a, b) => a - b)
  : []

describe('reti snapshot files', () => {
  for (const round of rounds) {
    describe(`${round}.json`, () => {
      const snapshot = readSnapshot(round)

      it('is at its own round', () => {
        expect(snapshot.round).toBe(round)
      })

      it('pools ascend numerically, stakers ascend by codepoint', () => {
        const poolIds = Object.keys(snapshot.pools)
        for (let i = 1; i < poolIds.length; i++) {
          expect(BigInt(poolIds[i - 1]) < BigInt(poolIds[i])).toBe(true)
        }
        for (const stakers of Object.values(snapshot.pools)) {
          const addresses = Object.keys(stakers)
          for (let i = 1; i < addresses.length; i++) {
            expect(addresses[i - 1] < addresses[i]).toBe(true)
          }
        }
      })

      it('holds positive balances and sane entry rounds', () => {
        for (const stakers of Object.values(snapshot.pools)) {
          for (const { balance, entryRound } of Object.values(stakers)) {
            expect(BigInt(balance)).toBeGreaterThan(0n)
            expect(entryRound).toBeGreaterThan(Number(RETI_APP_CREATION_ROUND))
            expect(entryRound).toBeLessThan(round + STAKING_BLOCK_DELAY)
          }
        }
      })
    })
  }
})
