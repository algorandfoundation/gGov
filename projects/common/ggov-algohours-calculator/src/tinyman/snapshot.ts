/**
 * Reconstruct tALGO/stALGO balances at a given round R.
 *
 * Forward-scans all ASA transfers from asset creation up to round R (exclusive),
 * producing balances just before round R transactions execute.
 *
 * Output: snapshots/tinyman/<round>.json
 *   { round, balances: { addr: { talgo, stalgo } }, excluded: { addr: { talgo, stalgo } } }
 *   `balances`  — algoquarter-eligible addresses
 *   `excluded`  — non-eligible addresses (kept for supply verification; see exclusions.ts)
 *
 * Usage:
 *   pnpm snapshot:tinyman <round>                    # scan from genesis and write snapshots/<round>.json
 *   pnpm snapshot:tinyman <round> --save-transfers   # also stream all transfers to snapshots/<round>.transfers.log
 *   pnpm snapshot:tinyman <round> --check            # re-scan and diff against existing file (no write)
 *   pnpm snapshot:tinyman <round> --inspect          # print supply stats from an existing snapshot (no scan)
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { STALGO_APP_ADDRESS, STALGO_ASA_ID, TALGO_APP_ADDRESS, TALGO_ASA_ID } from './constants'
import { scanAssetTransfers, fetchAssetMetadata } from '../indexer'
import { applyTransfer } from './ledger'
import { createSnapshot, diffSnapshot, getSnapshotPath, readSnapshot, writeSnapshot } from './snapshot/operations'
import { openTransferLog } from '../utils/transfer-log'
import type { BalanceMap } from './types'
import { logSnapshotStats, checkLargeHolders } from './snapshot/stats'

async function main() {
  const args = process.argv.slice(2)
  const saveTransfers = args.includes('--save-transfers')
  const check = args.includes('--check')
  const inspect = args.includes('--inspect')
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'))

  if (positionalArgs.length !== 1 || !/^\d+$/.test(positionalArgs[0])) {
    throw new Error('Usage: pnpm snapshot:tinyman <round> [--save-transfers] [--check] [--inspect]')
  }
  const targetRound = BigInt(positionalArgs[0])
  const storedPath = getSnapshotPath(targetRound)

  // Logs stats of existing snapshot (no scan, no write)
  if (inspect) {
    if (!existsSync(storedPath)) {
      throw new Error(`No snapshot to inspect: ${storedPath}\nRun: pnpm snapshot:tinyman ${targetRound}`)
    }
    logSnapshotStats(readSnapshot(targetRound))
    return
  }

  // Check flag fail-fast conditions
  if (check && !existsSync(storedPath)) {
    throw new Error(`No stored snapshot to check against: ${storedPath}\nRun: pnpm snapshot:tinyman ${targetRound}`)
  }
  if (!check && existsSync(storedPath)) {
    throw new Error(
      `Snapshot already exists: ${storedPath}\n` +
        `To verify it: pnpm snapshot:tinyman ${targetRound} --check\n` +
        `To regenerate: rm ${storedPath}`,
    )
  }

  // Reconstruct balances from asset creation
  console.log(`\nCreating snapshot at round ${targetRound}\n`)
  console.log('Fetching asset info…')
  const [tAlgoInfo, stAlgoInfo] = await Promise.all([
    fetchAssetMetadata(TALGO_ASA_ID),
    fetchAssetMetadata(STALGO_ASA_ID),
  ])
  console.log(`  tALGO created at round ${tAlgoInfo.creationRound} - total supply ${tAlgoInfo.totalSupply}`)
  console.log(`  stALGO created at round ${stAlgoInfo.creationRound} - total supply ${stAlgoInfo.totalSupply}`)
  const firstValidRound =
    tAlgoInfo.creationRound > stAlgoInfo.creationRound ? tAlgoInfo.creationRound : stAlgoInfo.creationRound
  if (targetRound < firstValidRound) {
    throw new Error(`Target round ${targetRound} precedes asset creation; use round >= ${firstValidRound}`)
  }

  // Directories
  const snapshotsDir = dirname(storedPath)
  mkdirSync(snapshotsDir, { recursive: true })
  const transferLogPath = join(snapshotsDir, `${targetRound}.transfers.log`)

  // Stream scanned transfers to a log file for debugging and inspection
  const transferLog = saveTransfers ? openTransferLog(transferLogPath) : undefined
  if (transferLog) {
    console.log(`\nLogging transfers to ${transferLogPath}`)
  }

  // Seed initial balances with the ASA creation (acfg) allocations
  // Each asset was created by its app, which initially holds the full reserve
  const balances: BalanceMap = new Map([
    [TALGO_APP_ADDRESS, { talgo: tAlgoInfo.totalSupply, stalgo: 0n }],
    [STALGO_APP_ADDRESS, { talgo: 0n, stalgo: stAlgoInfo.totalSupply }],
  ])

  // Scan transfers and apply them to the mutable balance map
  try {
    console.log(`\nScanning tALGO transfers [${tAlgoInfo.creationRound}, ${targetRound})…`)
    await scanAssetTransfers(
      TALGO_ASA_ID,
      tAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) {
          applyTransfer(balances, transfer, 'talgo')
          transferLog?.write('tALGO', transfer)
        }
      },
      'tALGO',
    )

    console.log(`\nScanning stALGO transfers [${stAlgoInfo.creationRound}, ${targetRound})…`)
    await scanAssetTransfers(
      STALGO_ASA_ID,
      stAlgoInfo.creationRound,
      targetRound,
      (transfers) => {
        for (const transfer of transfers) {
          applyTransfer(balances, transfer, 'stalgo')
          transferLog?.write('stALGO', transfer)
        }
      },
      'stALGO',
    )
  } finally {
    if (transferLog) {
      await transferLog.close()
      console.log(`\nTransfers logged to ${transferLogPath}`)
    }
  }

  const snapshot = createSnapshot(targetRound, balances)

  logSnapshotStats(snapshot)

  // Snapshot verification: recalculate from scratch and check against stored snapshot (no write)
  if (check) {
    console.log(`\nChecking against ${storedPath}…`)
    const diffs = diffSnapshot(balances, readSnapshot(targetRound))
    if (diffs.length === 0) {
      console.log('  ✓ Identical — snapshots match')
    } else {
      throw new Error(`${diffs.length} snapshot mismatch(es):\n${diffs.join('\n')}`)
    }
    return
  }

  // Save snapshot to file
  const outPath = writeSnapshot(snapshot)
  console.log(`\nSnapshot written to ${outPath}`)

  // Keep the snapshot for inspection, but fail if an eligible holder exceeds the threshold
  checkLargeHolders(snapshot)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
