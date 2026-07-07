/** Create, (de)serialize, persist, and compare pool ledger snapshots. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSnapshotFiles } from '../../snapshots'
import type { PoolLedger, RetiSnapshotData, StakerInfo } from '../types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SNAPSHOTS_DIR = join(__dirname, '../../..', 'snapshots', 'reti')

export const { getSnapshotPath, readSnapshot, writeSnapshot, latestSnapshotRound } =
  createSnapshotFiles<RetiSnapshotData>(SNAPSHOTS_DIR, 'pnpm snapshot:reti')

export function deserializePools(snapshot: RetiSnapshotData): PoolLedger {
  return new Map(
    Object.entries(snapshot.pools).map(([poolAppId, stakers]) => [
      BigInt(poolAppId),
      new Map(
        Object.entries(stakers).map(([staker, { balance, entryRound }]) => [
          staker,
          { balance: BigInt(balance), entryRound },
        ]),
      ),
    ]),
  )
}

export function createSnapshot(round: bigint, pools: PoolLedger): RetiSnapshotData {
  const serialized: RetiSnapshotData['pools'] = {}

  const sortedPools = [...pools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [poolAppId, stakers] of sortedPools) {
    const sortedStakers = [...stakers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const pool: RetiSnapshotData['pools'][string] = {}
    for (const [staker, { balance, entryRound }] of sortedStakers) {
      if (balance === 0n) continue
      pool[staker] = { balance: balance.toString(), entryRound }
    }
    if (Object.keys(pool).length > 0) serialized[poolAppId.toString()] = pool
  }

  return { round: Number(round), pools: serialized }
}

export function diffSnapshot(computed: PoolLedger, stored: RetiSnapshotData): string[] {
  const expected = deserializePools(stored)
  const poolAppIds = [...new Set([...computed.keys(), ...expected.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const diffs: string[] = []

  const none = { balance: 0n, entryRound: 0 }
  for (const poolAppId of poolAppIds) {
    const computedPool = computed.get(poolAppId) ?? new Map<string, StakerInfo>()
    const expectedPool = expected.get(poolAppId) ?? new Map<string, StakerInfo>()
    const stakers = [...new Set([...computedPool.keys(), ...expectedPool.keys()])].sort()

    for (const staker of stakers) {
      const actual = computedPool.get(staker) ?? none
      const wanted = expectedPool.get(staker) ?? none
      const parts: string[] = []

      if (wanted.balance !== actual.balance) parts.push(`balance ${wanted.balance}→${actual.balance}`)
      if (wanted.entryRound !== actual.entryRound) parts.push(`entryRound ${wanted.entryRound}→${actual.entryRound}`)
      if (parts.length > 0) diffs.push(`  [${diffs.length + 1}] pool ${poolAppId} ${staker}  ${parts.join('  ')}`)
    }
  }

  return diffs
}
