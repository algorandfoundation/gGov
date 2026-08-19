/**
 * Compute time-weighted reti staked holdings for a round window.
 *
 * Loads the pool snapshot at periodStart, scans all ValidatorRegistry events in
 * [periodStart, periodEnd), and writes each staker's algoquarters.
 *
 * Input:  snapshots/reti/<periodStart>.json
 * Output: data/reti/<periodStart>-<periodEnd>.json
 *   { networkGenesisHash, protocol, periodStart, periodEnd,
 *     totalAccounts, totalAlgoQuarters, accounts: [{ account, algoQuarters }] }
 *
 * Usage:
 *   pnpm algoquarters:reti <periodStart> <periodEnd>                  # compute algoquarters and create/verify upcoming snapshots
 *   pnpm algoquarters:reti <periodStart> <periodEnd> --no-snapshot    # skip creating/verifying snapshots
 *   pnpm algoquarters:reti <periodStart> <periodEnd> --save-events    # also write data/<start>-<end>.events.log
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_WINDOW } from '../config.ts'
import { fetchGenesisHash } from '../indexer.ts'
import { createIndexerClient } from '../config.ts'
import { checkOrCreateSnapshots } from '../snapshots.ts'
import { stringifyJson } from '../utils/json.ts'
import { assertAlgoQuartersFitUint32 } from '../utils/aq.ts'
import { PROTOCOL } from './constants.ts'
import { computeRetiAlgoQuarters } from './compute.ts'
import { fetchRetiEvents } from './indexer.ts'
import { applyRetiEvent } from './ledger.ts'
import * as snapshotStore from './snapshot/operations.ts'
import type { AlgoQuartersData } from '../types.ts'
import type { PoolLedger, RetiEvent } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../..', 'data', 'reti')

function clonePools(pools: PoolLedger): PoolLedger {
  return new Map([...pools].map(([poolAppId, stakers]) => [poolAppId, new Map(stakers)]))
}

/** One event as a compact JSON line (bigint as decimal string) for the events log. */
function stringifyEventLine(event: RetiEvent): string {
  return JSON.stringify(event, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const indexer = createIndexerClient()
  const args = process.argv.slice(2)
  const saveSnapshots = !args.includes('--no-snapshot')
  const saveEvents = args.includes('--save-events')
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'))

  if (positionalArgs.length !== 2 || positionalArgs.some((arg) => !/^\d+$/.test(arg))) {
    throw new Error('Usage: pnpm algoquarters:reti <periodStart> <periodEnd> [--no-snapshot] [--save-events]')
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

  console.log(`\nComputing reti algoquarters for rounds [${periodStart}, ${periodEnd})\n`)

  // Load inputs
  console.log(`Loading snapshot at round ${periodStart}…`)
  const origin = snapshotStore.readSnapshot(periodStart)
  const pools = snapshotStore.deserializePools(origin)
  console.log(`  ${pools.size} pools loaded`)

  console.log('\nFetching network genesis hash…')
  const networkGenesisHash = await fetchGenesisHash(indexer)
  console.log(`  networkGenesisHash = ${networkGenesisHash}`)

  // Scan events from periodStart to periodEnd and store them in memory
  console.log(`\nScanning reti events [${periodStart}, ${periodEnd})…`)
  const { events, epochRoundLengths } = await fetchRetiEvents(indexer, periodStart, periodEnd)
  const poolCount = new Set(events.map((event) => event.poolAppId)).size
  console.log(
    `\n  reti events in window: ${events.length} from ${epochRoundLengths.size} validators and ${poolCount} pools`,
  )

  if (saveEvents) {
    const eventsLogPath = join(DATA_DIR, `${periodStart}-${periodEnd}.events.log`)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(eventsLogPath, events.map((event) => stringifyEventLine(event)).join('\n') + '\n')
    console.log(`  Events logged to ${eventsLogPath}`)
  }

  // Preserve starting balances before computeRetiAlgoQuarters mutates them
  const snapshotPools = saveSnapshots ? clonePools(pools) : undefined

  // Compute output
  console.log('\nComputing round-weighted algoquarters…')
  const algoQuartersByStaker = computeRetiAlgoQuarters(
    pools,
    events,
    epochRoundLengths,
    Number(periodStart),
    Number(periodEnd),
  )

  // No exclusion list is needed: pool escrows hold the ALGO but never appear as stakers,
  // and validator commission is paid out directly.
  // The unit is the eligibility cutoff: stakers flooring below 1 AQ are omitted.
  const eligible = [...algoQuartersByStaker.entries()]
    .filter(([, aq]) => aq > 0n)
    // Codepoint order (not locale-dependent), matching the committee-file convention
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  // An estimate of how many stakers were dropped below 1 AQ due to flooring, for reporting purposes.
  // It is an estimate as there's an edge case for stakers that add and fully remove stake within the
  // same round, so the entry is created in the pool ledger and its accrual is genuinely zero.
  const dropped = [...algoQuartersByStaker.values()].filter((aq) => aq === 0n).length

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
    totalAccounts: accounts.length,
    totalAlgoQuarters: totalAlgoQuarters.toString(),
    accounts,
  }

  // Check or build snapshots in the window (periodStart, periodEnd]
  if (snapshotPools) {
    const pendingSnapshots = checkOrCreateSnapshots(
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
  console.log(`\nAlgoquarters written to ${outPath}`)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
