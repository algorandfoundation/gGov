/**
 * Compute time-weighted reti staked holdings for a round window.
 *
 * Loads the pool snapshot at periodStart, scans all ValidatorRegistry events in
 * [periodStart, periodEnd), and writes each staker's algohours.
 *
 * Input:  snapshots/reti/<periodStart>.json
 * Output: data/reti/<periodStart>-<periodEnd>.json
 *   { networkGenesisHash, protocol, periodStart, periodEnd, periodStartTime, periodEndTime,
 *     totalAccounts, totalAlgoHours, accounts: [{ account, algoHours }] }
 *
 * Usage:
 *   pnpm algohours:reti <periodStart> <periodEnd>                  # compute algohours and create/verify upcoming snapshots
 *   pnpm algohours:reti <periodStart> <periodEnd> --no-snapshot    # skip creating/verifying snapshots
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_WINDOW } from '../config'
import { fetchBlockTimestamp, fetchGenesisHash } from '../indexer'
import { checkOrCreateSnapshots } from '../snapshots'
import { stringifyJson } from '../utils/json'
import { PROTOCOL } from './constants'
import { computeRetiAlgoHours } from './compute'
import { fetchEpochRoundLengths, scanRetiEvents } from './indexer'
import { applyRetiEvent } from './ledger'
import * as snapshotStore from './snapshot/operations'
import type { AlgoHoursData } from '../types'
import type { PoolLedger, RetiEvent } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../..', 'data', 'reti')

function clonePools(pools: PoolLedger): PoolLedger {
  return new Map([...pools].map(([poolAppId, stakers]) => [poolAppId, new Map(stakers)]))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const saveSnapshots = !args.includes('--no-snapshot')
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'))

  if (positionalArgs.length !== 2 || positionalArgs.some((arg) => !/^\d+$/.test(arg))) {
    throw new Error('Usage: pnpm algohours:reti <periodStart> <periodEnd> [--no-snapshot]')
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

  console.log(`\nComputing reti algohours for rounds [${periodStart}, ${periodEnd})\n`)

  // Load inputs
  console.log(`Loading snapshot at round ${periodStart}…`)
  const origin = snapshotStore.readSnapshot(periodStart)
  const pools = snapshotStore.deserializePools(origin)
  const startTimestamp = origin.timestamp
  console.log(`  ${pools.size} pools loaded`)
  console.log(`  startTimestamp = ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`)

  console.log('\nFetching network genesis hash…')
  const networkGenesisHash = await fetchGenesisHash()
  console.log(`  networkGenesisHash = ${networkGenesisHash}`)

  console.log(`\nFetching block timestamp for round ${periodEnd}…`)
  const endTimestamp = await fetchBlockTimestamp(periodEnd)
  console.log(`  endTimestamp = ${endTimestamp} (${new Date(endTimestamp * 1000).toISOString()})`)
  console.log(`  Window duration: ${((endTimestamp - startTimestamp) / 3600 / 24).toFixed(2)} days`)

  // Scan events from periodStart to periodEnd and store them in memory
  const events: RetiEvent[] = []
  console.log(`\nScanning reti events [${periodStart}, ${periodEnd})…`)
  await scanRetiEvents(periodStart, periodEnd, (batch) => {
    for (const event of batch) events.push(event)
  })
  console.log(`\n  reti events in window: ${events.length}`)

  console.log('\nFetching validator epoch lengths…')
  const epochRoundLengths = await fetchEpochRoundLengths(events.map((event) => event.validatorId))
  console.log(`  ${epochRoundLengths.size} validators`)

  // Preserve starting balances before computeRetiAlgoHours mutates them
  const snapshotPools = saveSnapshots ? clonePools(pools) : undefined

  // Compute output
  console.log('\nComputing time-weighted algohours…')
  const algoHoursByStaker = computeRetiAlgoHours(pools, events, epochRoundLengths, startTimestamp, endTimestamp)

  // Every staker is eligible: pool escrows hold the ALGO but never appear as stakers,
  // and validator commission is paid out directly, so no exclusion list is needed.
  const accounts = [...algoHoursByStaker.entries()]
    .filter(([, algoHours]) => algoHours > 0n)
    .map(([account, algoHours]) => ({ account, algoHours: algoHours.toString() }))
    // Codepoint order (not locale-dependent), matching the committee-file convention
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0))

  const totalAlgoHours = accounts.reduce((sum, account) => sum + BigInt(account.algoHours), 0n)
  console.log(`  Eligible accounts: ${accounts.length}`)
  console.log(`  Total algohours: ${(totalAlgoHours / 1_000_000n).toLocaleString()} ALGO·h`)

  const output: AlgoHoursData = {
    networkGenesisHash,
    protocol: PROTOCOL,
    periodStart: Number(periodStart),
    periodEnd: Number(periodEnd),
    periodStartTime: startTimestamp,
    periodEndTime: endTimestamp,
    totalAccounts: accounts.length,
    totalAlgoHours: totalAlgoHours.toString(),
    accounts,
  }

  // Check or build snapshots in the window (periodStart, periodEnd]
  if (snapshotPools) {
    const pendingSnapshots = await checkOrCreateSnapshots(
      snapshotStore,
      snapshotPools,
      events,
      (pools, event) => applyRetiEvent(pools, event, epochRoundLengths),
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
