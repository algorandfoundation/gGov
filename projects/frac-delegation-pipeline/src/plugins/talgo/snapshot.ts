/**
 * Balance snapshots: create, (de)serialize, persist, compare, and rebuild from chain history.
 *
 * A snapshot at round `R` is the tALGO/stALGO balance of every address after all transactions in
 * rounds `< R` — i.e. just before round `R` executes. It is what an AlgoQuarters window starts
 * from, so `[periodStart, periodEnd)` only has to scan its own rounds rather than all of history.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Indexer } from 'algosdk'

import { createSnapshotFiles, fetchAssetMetadata, scanAssetTransfers } from '../../aq/index.ts'
import { STALGO_APP_ADDRESS, STALGO_ASA_ID, TALGO_APP_ADDRESS, TALGO_ASA_ID } from './constants.ts'
import { isExcluded } from './exclusions.ts'
import { applyTransfer } from './ledger.ts'
import type { BalanceMap, SnapshotData } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Where snapshots live unless a plugin override says otherwise: `<package>/snapshots/talgo`. */
export const DEFAULT_SNAPSHOTS_DIR = join(__dirname, '../../..', 'snapshots', 'talgo')

/**
 * File persistence bound to one snapshots directory, plus the pure snapshot operations. Satisfies
 * `SnapshotStore`, so it can be handed straight to `createSnapshotChain`.
 */
export function createTalgoSnapshotStore(snapshotsDir: string = DEFAULT_SNAPSHOTS_DIR) {
  const files = createSnapshotFiles<SnapshotData>(snapshotsDir, 'TalgoPipelinePlugin.buildSnapshot')
  return { ...files, snapshotsDir, createSnapshot, diffSnapshot, toState: getAllSnapshotBalances }
}

export type TalgoSnapshotStore = ReturnType<typeof createTalgoSnapshotStore>

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

export function createSnapshot(round: bigint, balances: BalanceMap): SnapshotData {
  const eligible: SnapshotData['balances'] = {}
  const excluded: SnapshotData['excluded'] = {}

  const sortedBalances = [...balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [address, balance] of sortedBalances) {
    if (balance.talgo === 0n && balance.stalgo === 0n) continue

    const serialized = { talgo: balance.talgo.toString(), stalgo: balance.stalgo.toString() }
    if (isExcluded(address)) excluded[address] = serialized
    else eligible[address] = serialized
  }

  return { round: Number(round), balances: eligible, excluded }
}

export function diffBalances(computed: BalanceMap, expected: BalanceMap): string[] {
  const addresses = [...new Set([...computed.keys(), ...expected.keys()])].sort()
  const diffs: string[] = []

  for (const address of addresses) {
    const actual = computed.get(address) ?? { talgo: 0n, stalgo: 0n }
    const wanted = expected.get(address) ?? { talgo: 0n, stalgo: 0n }
    const parts: string[] = []

    if (wanted.talgo !== actual.talgo) parts.push(`talgo ${wanted.talgo}→${actual.talgo}`)
    if (wanted.stalgo !== actual.stalgo) parts.push(`stalgo ${wanted.stalgo}→${actual.stalgo}`)
    if (parts.length > 0) diffs.push(`  [${diffs.length + 1}] ${address}  ${parts.join('  ')}`)
  }

  return diffs
}

export function diffSnapshot(computed: BalanceMap, stored: SnapshotData): string[] {
  return diffBalances(computed, getAllSnapshotBalances(stored))
}

/**
 * Rebuild balances at `targetRound` by forward-scanning every tALGO and stALGO transfer from asset
 * creation. The cold path: minutes of Indexer work, and the reason snapshots are committed at all.
 *
 * Seeds from the ASA creation allocations — each asset was created by its own app, which initially
 * holds the entire supply — so it depends on no present-day chain state.
 */
export async function buildSnapshot(indexer: Indexer, targetRound: bigint): Promise<SnapshotData> {
  const [tAlgoInfo, stAlgoInfo] = await Promise.all([
    fetchAssetMetadata(indexer, TALGO_ASA_ID),
    fetchAssetMetadata(indexer, STALGO_ASA_ID),
  ])
  const firstValidRound =
    tAlgoInfo.creationRound > stAlgoInfo.creationRound ? tAlgoInfo.creationRound : stAlgoInfo.creationRound
  if (targetRound < firstValidRound) {
    throw new Error(`talgo: snapshot round ${targetRound} precedes asset creation; use round >= ${firstValidRound}`)
  }

  const balances: BalanceMap = new Map([
    [TALGO_APP_ADDRESS, { talgo: tAlgoInfo.totalSupply, stalgo: 0n }],
    [STALGO_APP_ADDRESS, { talgo: 0n, stalgo: stAlgoInfo.totalSupply }],
  ])

  // The two scans overlap even though they share `balances`: `applyTransfer` only ever touches the
  // field it is given, the two assets never write each other's, and `onBatch` runs synchronously —
  // so interleaving the batches cannot make the two streams observe each other.
  await Promise.all([
    scanAssetTransfers(
      indexer,
      TALGO_ASA_ID,
      tAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) applyTransfer(balances, transfer, 'talgo')
      },
      'tALGO',
    ),
    scanAssetTransfers(
      indexer,
      STALGO_ASA_ID,
      stAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) applyTransfer(balances, transfer, 'stalgo')
      },
      'stALGO',
    ),
  ])

  return createSnapshot(targetRound, balances)
}
