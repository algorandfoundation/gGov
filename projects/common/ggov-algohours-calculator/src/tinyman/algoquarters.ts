/**
 * Compute time-weighted tALGO/stALGO holdings for a round window.
 *
 * Loads the balance snapshot at periodStart, scans all ASA transfers in
 * [periodStart, periodEnd), and writes each eligible account's algoquarters.
 *
 * Input:  snapshots/tinyman/<periodStart>.json
 * Output: data/tinyman/<periodStart>-<periodEnd>.json
 *   { networkGenesisHash, protocol, periodStart, periodEnd,
 *     rate, totalAccounts, totalAlgoQuarters, accounts: [{ account, algoQuarters }] }
 *
 * Usage:
 *   pnpm algoquarters:tinyman <periodStart> <periodEnd>                    # compute algoquarters and create/verify upcoming snapshots
 *   pnpm algoquarters:tinyman <periodStart> <periodEnd> --save-transfers   # also write data/<start>-<end>.transfers.log
 *   pnpm algoquarters:tinyman <periodStart> <periodEnd> --no-snapshot      # skip creating/verifying snapshots
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_WINDOW } from '../config'
import { PROTOCOL, RATE_SCALER, STALGO_ASA_ID, TALGO_ASA_ID } from './constants'
import { isExcluded } from './exclusions'
import { scanAssetTransfers, fetchGenesisHash } from '../indexer'
import { fetchTAlgoRateInRange } from './indexer'
import { applyTransfer } from './ledger'
import { computeAlgoQuarters, mergeAssetTransfers } from './compute'
import * as snapshotStore from './snapshot/operations'
import { checkOrCreateSnapshots } from '../snapshots'
import { openTransferLog } from '../utils/transfer-log'
import { stringifyJson } from '../utils/json'
import { assertAlgoQuartersFitUint32 } from '../utils/aq'
import type { AlgoQuartersData, AssetTransfer } from '../types'
import type { BalanceMap } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../..', 'data', 'tinyman')
const RATE_DECIMAL_PLACES = RATE_SCALER.toString().length - 1

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function cloneBalances(balances: BalanceMap): BalanceMap {
  return new Map([...balances].map(([address, balance]) => [address, { talgo: balance.talgo, stalgo: balance.stalgo }]))
}

function formatRate(rate: bigint): string {
  const integer = rate / RATE_SCALER
  const fraction = (rate % RATE_SCALER).toString().padStart(RATE_DECIMAL_PLACES, '0')
  return `${integer}.${fraction}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const saveSnapshots = !args.includes('--no-snapshot')
  const saveTransfers = args.includes('--save-transfers')
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'))

  if (positionalArgs.length !== 2 || positionalArgs.some((arg) => !/^\d+$/.test(arg))) {
    throw new Error('Usage: pnpm algoquarters:tinyman <periodStart> <periodEnd> [--no-snapshot] [--save-transfers]')
  }

  const periodStart = BigInt(positionalArgs[0])
  const periodEnd = BigInt(positionalArgs[1])

  if (periodEnd <= periodStart) {
    throw new Error('periodEnd must be greater than periodStart')
  }
  if (periodEnd - periodStart > MAX_WINDOW) {
    throw new Error(
      `Window of ${periodEnd - periodStart} rounds exceeds the ${MAX_WINDOW} maximum — check the arguments.`,
    )
  }

  const outPath = join(DATA_DIR, `${periodStart}-${periodEnd}.json`)
  if (existsSync(outPath)) {
    throw new Error(`Algoquarters already computed for this period: ${outPath}\nTo regenerate: rm ${outPath}`)
  }

  console.log(`\nComputing algoquarters for rounds [${periodStart}, ${periodEnd})\n`)

  // Load inputs
  console.log(`Loading snapshot at round ${periodStart}…`)
  const origin = snapshotStore.readSnapshot(periodStart)
  const balances = snapshotStore.getAllSnapshotBalances(origin)
  console.log(`  ${balances.size} accounts loaded`)

  console.log(`\nFetching tALGO/ALGO rate in window [${periodStart}, ${periodEnd})…`)
  const tAlgoRate = await fetchTAlgoRateInRange(periodStart, periodEnd)
  if (tAlgoRate === null) throw new Error(`No rate_update event found in [${periodStart}, ${periodEnd})`)
  console.log(`  tAlgoRate = ${tAlgoRate} (1 tALGO ≈ ${(Number(tAlgoRate) / Number(RATE_SCALER)).toFixed(6)} ALGO)`)

  console.log('\nFetching network genesis hash…')
  const networkGenesisHash = await fetchGenesisHash()
  console.log(`  networkGenesisHash = ${networkGenesisHash}`)

  // Scan transfers from periodStart to periodEnd and store them in memory
  const tAlgoTransfers: AssetTransfer[] = []
  const stAlgoTransfers: AssetTransfer[] = []
  const transferLogPath = join(DATA_DIR, `${periodStart}-${periodEnd}.transfers.log`)
  if (saveTransfers) mkdirSync(DATA_DIR, { recursive: true })
  const transferLog = saveTransfers ? openTransferLog(transferLogPath) : undefined
  if (transferLog) console.log(`Logging transfers to ${transferLogPath}\n`)

  try {
    console.log(`\nScanning tALGO transfers [${periodStart}, ${periodEnd})…`)
    await scanAssetTransfers(
      TALGO_ASA_ID,
      periodStart,
      periodEnd,
      (batch) => {
        for (const transfer of batch) {
          tAlgoTransfers.push(transfer)
          transferLog?.write('tALGO', transfer)
        }
      },
      'tALGO',
    )

    console.log(`\nScanning stALGO transfers [${periodStart}, ${periodEnd})…`)
    await scanAssetTransfers(
      STALGO_ASA_ID,
      periodStart,
      periodEnd,
      (batch) => {
        for (const transfer of batch) {
          stAlgoTransfers.push(transfer)
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

  console.log(`\n  tALGO transfers in window: ${tAlgoTransfers.length}`)
  console.log(`  stALGO transfers in window: ${stAlgoTransfers.length}`)

  // Preserve starting balances before computeAlgoQuarters mutates them
  const snapshotBalances = saveSnapshots ? cloneBalances(balances) : undefined

  // Compute output
  console.log('\nComputing round-weighted algoquarters…')
  const transfers = mergeAssetTransfers(tAlgoTransfers, stAlgoTransfers)
  const algoQuartersByAddress = computeAlgoQuarters(
    balances,
    transfers,
    Number(periodStart),
    Number(periodEnd),
    tAlgoRate,
  )

  // The unit is the eligibility cutoff: accounts flooring below 1 AQ are omitted
  const eligible = [...algoQuartersByAddress.entries()]
    .filter(([address, aq]) => !isExcluded(address) && aq > 0n)
    // Codepoint order (not locale-dependent), matching the committee-file convention
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  // An estimate of how many accounts were dropped below 1 AQ due to rounding, for reporting purposes
  // It is estimate as there's an edge case for accounts that receive and fully forward within the window,
  // so the entry is created in the balance map and its genuinely zero.
  const dropped = [...algoQuartersByAddress.entries()].filter(
    ([address, aq]) => !isExcluded(address) && aq === 0n,
  ).length

  const accounts = eligible.map(([account, aq]) => {
    assertAlgoQuartersFitUint32(aq, account)
    return { account, algoQuarters: aq.toString() }
  })
  const totalAlgoQuarters = eligible.reduce((sum, [, aq]) => sum + aq, 0n)
  console.log(`  Eligible accounts: ${accounts.length}  (dropped below 1 AQ: ≤${dropped})`)
  console.log(`  Total algoquarters: ${totalAlgoQuarters.toLocaleString()} AQ`)

  const output: AlgoQuartersData = {
    networkGenesisHash,
    protocol: PROTOCOL,
    periodStart: Number(periodStart),
    periodEnd: Number(periodEnd),
    rate: formatRate(tAlgoRate),
    totalAccounts: accounts.length,
    totalAlgoQuarters: totalAlgoQuarters.toString(),
    accounts,
  }

  // Check or build snapshots in the window (periodStart, periodEnd]
  if (snapshotBalances) {
    const pendingSnapshots = checkOrCreateSnapshots(
      snapshotStore,
      snapshotBalances,
      transfers,
      (balances, transfer) => applyTransfer(balances, transfer, transfer.asset),
      periodStart,
      periodEnd,
    )

    // All snapshots verified — persist outputs
    for (const snapshot of pendingSnapshots) {
      console.log(`  Snapshot saved: ${snapshotStore.writeSnapshot(snapshot)}`)
    }
  }

  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(outPath, stringifyJson(output))
  console.log(`\nAlgoquarters written to ${outPath}`)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
