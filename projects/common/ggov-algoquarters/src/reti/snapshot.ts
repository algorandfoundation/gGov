/**
 * Reconstruct reti staked balances at a given round R.
 *
 * Forward-scans all `ValidatorRegistry` events from app creation up to round R
 * (exclusive), producing balances just before round R transactions execute.
 *
 * Output: snapshots/reti/<round>.json
 *   { round, pools: { poolAppId: { staker: { balance, entryRound } } } }
 *
 * Usage:
 *   pnpm snapshot:reti <round>            # scan from app creation and write snapshots/reti/<round>.json
 *   pnpm snapshot:reti <round> --check    # re-scan and diff against existing file (no write)
 *   pnpm snapshot:reti <round> --inspect  # print stake stats from an existing snapshot (no scan)
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { existsSync } from 'node:fs'

import { RETI_APP_CREATION_ROUND } from './constants.ts'
import { fetchRetiEvents } from './indexer.ts'
import { createIndexerClient } from '../config.ts'
import { applyRetiEvent, totalStaked } from './ledger.ts'
import {
  createSnapshot,
  deserializePools,
  diffSnapshot,
  getSnapshotPath,
  readSnapshot,
  writeSnapshot,
} from './snapshot/operations.ts'
import type { PoolLedger } from './types.ts'

/** Log pool, staker, and stake totals for a pool ledger. */
function logStakeStats(pools: PoolLedger, round: bigint): void {
  const stakers = new Set([...pools.values()].flatMap((pool) => [...pool.keys()]))
  const occupiedPools = [...pools.values()].filter((pool) => pool.size > 0).length
  console.log(`\nStake at round ${round}:`)
  console.log(`  pools           ${occupiedPools}`)
  console.log(`  unique stakers  ${stakers.size}`)
  console.log(`  total staked    ${totalStaked(pools).toLocaleString()} microALGO`)
}

async function main() {
  const indexer = createIndexerClient()
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const inspect = args.includes('--inspect')
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'))

  if (positionalArgs.length !== 1 || !/^\d+$/.test(positionalArgs[0])) {
    throw new Error('Usage: pnpm snapshot:reti <round> [--check] [--inspect]')
  }
  const targetRound = BigInt(positionalArgs[0])
  const storedPath = getSnapshotPath(targetRound)

  // Logs stats of existing snapshot (no scan, no write)
  if (inspect) {
    if (!existsSync(storedPath)) {
      throw new Error(`No snapshot to inspect: ${storedPath}\nRun: pnpm snapshot:reti ${targetRound}`)
    }
    logStakeStats(deserializePools(readSnapshot(targetRound)), targetRound)
    return
  }

  // Check flag fail-fast conditions
  if (check && !existsSync(storedPath)) {
    throw new Error(`No stored snapshot to check against: ${storedPath}\nRun: pnpm snapshot:reti ${targetRound}`)
  }
  if (!check && existsSync(storedPath)) {
    throw new Error(
      `Snapshot already exists: ${storedPath}\n` +
        `To verify it: pnpm snapshot:reti ${targetRound} --check\n` +
        `To regenerate: rm ${storedPath}`,
    )
  }
  if (targetRound < RETI_APP_CREATION_ROUND) {
    throw new Error(`Target round ${targetRound} precedes registry creation; use round >= ${RETI_APP_CREATION_ROUND}`)
  }

  // Reconstruct balances from registry creation
  console.log(`\nCreating snapshot at round ${targetRound}\n`)
  console.log(`Scanning reti events [${RETI_APP_CREATION_ROUND}, ${targetRound})…`)
  const { events, epochRoundLengths } = await fetchRetiEvents(indexer, RETI_APP_CREATION_ROUND, targetRound)
  const poolCount = new Set(events.map((event) => event.poolAppId)).size
  console.log(`\n  ${events.length} events from ${epochRoundLengths.size} validators and ${poolCount} pools`)

  // Apply events to mutable pool ledgers
  const pools: PoolLedger = new Map()
  for (const event of events) applyRetiEvent(pools, event, epochRoundLengths)

  const snapshot = createSnapshot(targetRound, pools)

  logStakeStats(pools, targetRound)

  // Snapshot verification: recalculate from scratch and check against stored snapshot (no write)
  if (check) {
    console.log(`\nChecking against ${storedPath}…`)
    const diffs = diffSnapshot(pools, readSnapshot(targetRound))
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
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
