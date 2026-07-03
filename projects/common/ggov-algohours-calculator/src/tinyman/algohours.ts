/**
 * Compute time-weighted tALGO/stALGO holdings for a round window.
 *
 * Loads the balance snapshot at periodStart, scans all ASA transfers in
 * [periodStart, periodEnd), and writes each eligible account's algohours.
 *
 * Input:  snapshots/tinyman/<periodStart>.json
 * Output: data/tinyman/<periodStart>-<periodEnd>.json
 *   { networkGenesisHash, protocol, periodStart, periodEnd, periodStartTime, periodEndTime,
 *     rate, totalAccounts, totalAlgoHours, accounts: [{ account, algoHours }] }
 *
 * Usage:
 *   pnpm algohours:tinyman <periodStart> <periodEnd>                    # compute algohours and create/verify upcoming snapshots
 *   pnpm algohours:tinyman <periodStart> <periodEnd> --save-transfers   # also write data/<start>-<end>.transfers.log
 *   pnpm algohours:tinyman <periodStart> <periodEnd> --no-snapshot      # skip creating/verifying snapshots
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
import { scanAssetTransfers, fetchBlockTimestamp, fetchGenesisHash } from '../indexer'
import { fetchTAlgoRateInRange } from './indexer'
import { applyTransfer } from './ledger'
import { computeAlgoHours, mergeAssetTransfers } from './compute'
import * as snapshotStore from './snapshot/operations'
import { checkOrCreateSnapshots } from '../snapshots'
import { openTransferLog } from '../utils/transfer-log'
import { stringifyJson } from '../utils/json'
import type { AlgoHoursData, AssetTransfer } from '../types'
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
    throw new Error('Usage: pnpm algohours:tinyman <periodStart> <periodEnd> [--no-snapshot] [--save-transfers]')
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
    throw new Error(`Algohours already computed for this period: ${outPath}\nTo regenerate: rm ${outPath}`)
  }

  console.log(`\nComputing algohours for rounds [${periodStart}, ${periodEnd})\n`)

  // Load inputs
  console.log(`Loading snapshot at round ${periodStart}…`)
  const origin = snapshotStore.readSnapshot(periodStart)
  const balances = snapshotStore.getAllSnapshotBalances(origin)
  const startTimestamp = origin.timestamp
  console.log(`  ${balances.size} accounts loaded`)
  console.log(`  startTimestamp = ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`)

  console.log(`\nFetching tALGO/ALGO rate in window [${periodStart}, ${periodEnd})…`)
  const tAlgoRate = await fetchTAlgoRateInRange(periodStart, periodEnd)
  if (tAlgoRate === null) throw new Error(`No rate_update event found in [${periodStart}, ${periodEnd})`)
  console.log(`  tAlgoRate = ${tAlgoRate} (1 tALGO ≈ ${(Number(tAlgoRate) / Number(RATE_SCALER)).toFixed(6)} ALGO)`)

  console.log('\nFetching network genesis hash…')
  const networkGenesisHash = await fetchGenesisHash()
  console.log(`  networkGenesisHash = ${networkGenesisHash}`)

  console.log(`\nFetching block timestamp for round ${periodEnd}…`)
  const endTimestamp = await fetchBlockTimestamp(periodEnd)
  console.log(`  endTimestamp = ${endTimestamp} (${new Date(endTimestamp * 1000).toISOString()})`)
  console.log(`  Window duration: ${((endTimestamp - startTimestamp) / 3600 / 24).toFixed(2)} days`)

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

  // Preserve starting balances before computeAlgoHours mutates them
  const snapshotBalances = saveSnapshots ? cloneBalances(balances) : undefined

  // Compute output
  console.log('\nComputing time-weighted algohours…')
  const transfers = mergeAssetTransfers(tAlgoTransfers, stAlgoTransfers)
  const algoHoursByAddress = computeAlgoHours(balances, transfers, startTimestamp, endTimestamp, tAlgoRate)

  const accounts = [...algoHoursByAddress.entries()]
    .filter(([address, algoHours]) => !isExcluded(address) && algoHours > 0n)
    .map(([account, algoHours]) => ({ account, algoHours: algoHours.toString() }))
    // Codepoint order (not locale-dependent), matching the committee-file convention
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0))

  const totalAlgoHours = accounts.reduce((sum, account) => sum + BigInt(account.algoHours), 0n)
  const accountsAboveThreshold = accounts.filter((account) => BigInt(account.algoHours) > 1_000n).length
  console.log(`  Eligible accounts: ${accounts.length}  (>0.001 ALGO·h: ${accountsAboveThreshold})`)
  console.log(`  Total algohours: ${(totalAlgoHours / 1_000_000n).toLocaleString()} ALGO·h`)

  const output: AlgoHoursData = {
    networkGenesisHash,
    protocol: PROTOCOL,
    periodStart: Number(periodStart),
    periodEnd: Number(periodEnd),
    periodStartTime: startTimestamp,
    periodEndTime: endTimestamp,
    rate: formatRate(tAlgoRate),
    totalAccounts: accounts.length,
    totalAlgoHours: totalAlgoHours.toString(),
    accounts,
  }

  // Check or build snapshots in the window (periodStart, periodEnd]
  if (snapshotBalances) {
    const pendingSnapshots = await checkOrCreateSnapshots(
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
  console.log(`\nAlgohours written to ${outPath}`)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
