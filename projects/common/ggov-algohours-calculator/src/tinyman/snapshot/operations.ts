/** Create, (de)serialize, persist, and compare balance snapshots. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isExcluded } from '../exclusions'
import { createSnapshotFiles } from '../../snapshots'
import type { BalanceMap, SnapshotData } from '../types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SNAPSHOTS_DIR = join(__dirname, '../../..', 'snapshots', 'tinyman')

export const { getSnapshotPath, readSnapshot, writeSnapshot } = createSnapshotFiles<SnapshotData>(
  SNAPSHOTS_DIR,
  'pnpm snapshot:tinyman',
)

export function deserializeBalances(section: SnapshotData['balances']): BalanceMap {
  return new Map(
    Object.entries(section).map(([address, balance]) => [
      address,
      { talgo: BigInt(balance.talgo), stalgo: BigInt(balance.stalgo) },
    ]),
  )
}

export function getAllSnapshotBalances(snapshot: SnapshotData): BalanceMap {
  return new Map([...deserializeBalances(snapshot.balances), ...deserializeBalances(snapshot.excluded)])
}

export function createSnapshot(round: bigint, timestamp: number, balances: BalanceMap): SnapshotData {
  const eligible: SnapshotData['balances'] = {}
  const excluded: SnapshotData['excluded'] = {}

  const sortedBalances = [...balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [address, balance] of sortedBalances) {
    if (balance.talgo === 0n && balance.stalgo === 0n) continue

    const serialized = { talgo: balance.talgo.toString(), stalgo: balance.stalgo.toString() }
    if (isExcluded(address)) excluded[address] = serialized
    else eligible[address] = serialized
  }

  return { round: Number(round), timestamp, balances: eligible, excluded }
}

export function diffSnapshot(computed: BalanceMap, stored: SnapshotData): string[] {
  const expectedBalances = getAllSnapshotBalances(stored)
  const addresses = [...new Set([...computed.keys(), ...expectedBalances.keys()])].sort()
  const diffs: string[] = []

  for (const address of addresses) {
    const actual = computed.get(address) ?? { talgo: 0n, stalgo: 0n }
    const expected = expectedBalances.get(address) ?? { talgo: 0n, stalgo: 0n }
    const parts: string[] = []

    if (expected.talgo !== actual.talgo) parts.push(`talgo ${expected.talgo}→${actual.talgo}`)
    if (expected.stalgo !== actual.stalgo) parts.push(`stalgo ${expected.stalgo}→${actual.stalgo}`)
    if (parts.length > 0) diffs.push(`  [${diffs.length + 1}] ${address}  ${parts.join('  ')}`)
  }

  return diffs
}
