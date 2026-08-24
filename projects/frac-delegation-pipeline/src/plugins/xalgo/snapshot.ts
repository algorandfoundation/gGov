/**
 * Balance snapshots: create, (de)serialize, persist, compare, and rebuild from chain history.
 *
 * A snapshot at round `R` is the xALGO and fxALGO balance of every address after all transactions
 * in rounds `< R` — i.e. just before round `R` executes. Balances are raw custody (escrows under
 * their own address): the snapshot reproduces chain state, owner resolution happens at attribution
 * time. `beneficiaries.json` lives in the same directory (see beneficiaries.ts).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Indexer } from 'algosdk'

import { createSnapshotFiles, fetchAssetMetadata, scanAssetTransfers } from '../../aq/index.ts'
import { FXALGO_ASA_ID, XALGO_APP_ADDRESS, XALGO_ASA_ID, XALGO_POOL_ADDRESS } from './constants.ts'
import { isExcluded } from './exclusions.ts'
import { applyTransfer } from './ledger.ts'
import type { AccountBalance, BalanceMap, SnapshotData } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Where snapshots live unless a plugin override says otherwise: `<package>/snapshots/xalgo`. */
export const DEFAULT_SNAPSHOTS_DIR = join(__dirname, '../../..', 'snapshots', 'xalgo')

/** The resolution cache, next to the snapshots it belongs with. */
export const BENEFICIARIES_FILE_NAME = 'beneficiaries.json'

/**
 * File persistence bound to one snapshots directory, plus the pure snapshot operations. Satisfies
 * `SnapshotStore`, so it can be handed straight to `createSnapshotChain`.
 */
export function createXalgoSnapshotStore(snapshotsDir: string = DEFAULT_SNAPSHOTS_DIR) {
  const files = createSnapshotFiles<SnapshotData>(snapshotsDir, 'XalgoPipelinePlugin.buildSnapshot')
  return {
    ...files,
    snapshotsDir,
    beneficiariesPath: join(snapshotsDir, BENEFICIARIES_FILE_NAME),
    createSnapshot,
    diffSnapshot,
    toState: getAllSnapshotBalances,
  }
}

export type XalgoSnapshotStore = ReturnType<typeof createXalgoSnapshotStore>

const ZERO: AccountBalance = { xalgo: 0n, fxalgo: 0n }

export function deserializeBalances(section: SnapshotData['balances']): BalanceMap {
  return new Map(
    Object.entries(section).map(([address, balance]) => [
      address,
      { xalgo: BigInt(balance.xalgo), fxalgo: BigInt(balance.fxalgo) },
    ]),
  )
}

export function getAllSnapshotBalances(snapshot: SnapshotData): BalanceMap {
  return new Map([...deserializeBalances(snapshot.balances), ...deserializeBalances(snapshot.excluded)])
}

/** Drop all-zero entries, split eligible from excluded, serialize in codepoint order. */
export function createSnapshot(round: bigint, balances: BalanceMap): SnapshotData {
  const eligible: SnapshotData['balances'] = {}
  const excluded: SnapshotData['excluded'] = {}

  const sortedBalances = [...balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [address, balance] of sortedBalances) {
    if (balance.xalgo === 0n && balance.fxalgo === 0n) continue

    const serialized = { xalgo: balance.xalgo.toString(), fxalgo: balance.fxalgo.toString() }
    if (isExcluded(address)) excluded[address] = serialized
    else eligible[address] = serialized
  }

  return { round: Number(round), balances: eligible, excluded }
}

export function diffBalances(computed: BalanceMap, expected: BalanceMap): string[] {
  const addresses = [...new Set([...computed.keys(), ...expected.keys()])].sort()
  const diffs: string[] = []

  for (const address of addresses) {
    const actual = computed.get(address) ?? ZERO
    const wanted = expected.get(address) ?? ZERO
    const parts: string[] = []

    if (wanted.xalgo !== actual.xalgo) parts.push(`xalgo ${wanted.xalgo}→${actual.xalgo}`)
    if (wanted.fxalgo !== actual.fxalgo) parts.push(`fxalgo ${wanted.fxalgo}→${actual.fxalgo}`)
    if (parts.length > 0) diffs.push(`  [${diffs.length + 1}] ${address}  ${parts.join('  ')}`)
  }

  return diffs
}

export function diffSnapshot(computed: BalanceMap, stored: SnapshotData): string[] {
  return diffBalances(computed, getAllSnapshotBalances(stored))
}

/**
 * Rebuild balances at `targetRound` by forward-scanning every xALGO and fxALGO transfer from asset
 * creation. The cold path: tens of minutes of Indexer work, and the reason snapshots are committed.
 *
 * Seeds from the ASA creation allocations — each asset was created by its own app, which initially
 * holds the entire supply (xALGO by the consensus app, fxALGO by the pool) — so it depends on no
 * present-day chain state.
 */
export async function buildSnapshot(
  indexer: Indexer,
  targetRound: bigint,
  concurrency?: number,
): Promise<SnapshotData> {
  const [xAlgoInfo, fxAlgoInfo] = await Promise.all([
    fetchAssetMetadata(indexer, XALGO_ASA_ID),
    fetchAssetMetadata(indexer, FXALGO_ASA_ID),
  ])
  const firstValidRound =
    xAlgoInfo.creationRound > fxAlgoInfo.creationRound ? xAlgoInfo.creationRound : fxAlgoInfo.creationRound
  if (targetRound < firstValidRound) {
    throw new Error(`xalgo: snapshot round ${targetRound} precedes asset creation; use round >= ${firstValidRound}`)
  }

  const balances: BalanceMap = new Map([
    [XALGO_APP_ADDRESS, { xalgo: xAlgoInfo.totalSupply, fxalgo: 0n }],
    [XALGO_POOL_ADDRESS, { xalgo: 0n, fxalgo: fxAlgoInfo.totalSupply }],
  ])

  // The two scans overlap even though they share `balances`: `applyTransfer` only ever touches the
  // field it is given, the two assets never write each other's, and `onBatch` runs synchronously —
  // so interleaving the batches cannot make the two streams observe each other.
  await Promise.all([
    scanAssetTransfers(
      indexer,
      XALGO_ASA_ID,
      xAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) applyTransfer(balances, transfer, 'xalgo')
      },
      'xALGO',
      concurrency,
    ),
    scanAssetTransfers(
      indexer,
      FXALGO_ASA_ID,
      fxAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) applyTransfer(balances, transfer, 'fxalgo')
      },
      'fxALGO',
      concurrency,
    ),
  ])

  return createSnapshot(targetRound, balances)
}
