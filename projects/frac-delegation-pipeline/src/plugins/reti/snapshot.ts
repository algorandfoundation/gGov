/**
 * Pool ledger snapshots: create, (de)serialize, persist, compare, and rebuild from chain history.
 *
 * A snapshot at round `R` holds every staker's position in every pool after all transactions in
 * rounds `< R` — i.e. just before round `R` executes. It is what an AlgoQuarters window starts
 * from, so `[periodStart, periodEnd)` only has to scan its own rounds rather than all of history.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Indexer } from 'algosdk'

import { createSnapshotFiles } from '../../aq/index.ts'
import { RETI_APP_CREATION_ROUND } from './constants.ts'
import { fetchRetiEvents } from './indexer.ts'
import { applyRetiEvent, totalStaked } from './ledger.ts'
import type { PoolLedger, RetiSnapshotData, StakerInfo } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Where snapshots live unless a plugin override says otherwise: `<package>/snapshots/reti`. */
export const DEFAULT_SNAPSHOTS_DIR = join(__dirname, '../../..', 'snapshots', 'reti')

/**
 * File persistence bound to one snapshots directory, plus the pure snapshot operations. Satisfies
 * `SnapshotStore`, so it can be handed straight to `checkOrCreateSnapshots`.
 */
export function createRetiSnapshotStore(snapshotsDir: string = DEFAULT_SNAPSHOTS_DIR) {
  const files = createSnapshotFiles<RetiSnapshotData>(snapshotsDir, 'RetiPipelinePlugin.buildSnapshot')
  return { ...files, snapshotsDir, createSnapshot, diffSnapshot }
}

export type RetiSnapshotStore = ReturnType<typeof createRetiSnapshotStore>

/** The packaged store, for the file-shape tests that read the committed snapshots directly. */
export const { getSnapshotPath, readSnapshot, writeSnapshot, latestSnapshotRound } = createRetiSnapshotStore()

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

/** Pool, staker, and stake totals for a pool ledger. */
export function logStakeStats(pools: PoolLedger, round: bigint): void {
  const stakers = new Set([...pools.values()].flatMap((pool) => [...pool.keys()]))
  const occupiedPools = [...pools.values()].filter((pool) => pool.size > 0).length
  console.log(`\n[reti] stake at round ${round}:`)
  console.log(`  pools           ${occupiedPools}`)
  console.log(`  unique stakers  ${stakers.size}`)
  console.log(`  total staked    ${totalStaked(pools).toLocaleString()} microALGO`)
}

/**
 * Rebuild every pool's staker positions at `targetRound` by forward-scanning the registry's whole
 * event stream from its creation round. The cold path: minutes of Indexer work, and the reason
 * snapshots are committed at all.
 *
 * Depends on no present-day chain state — the registry logs every balance change, so the ledger is
 * reconstructed from the events alone.
 */
export async function buildSnapshot(
  indexer: Indexer,
  registryAppId: bigint,
  targetRound: bigint,
): Promise<RetiSnapshotData> {
  if (targetRound < RETI_APP_CREATION_ROUND) {
    throw new Error(
      `reti: snapshot round ${targetRound} precedes registry creation; use round >= ${RETI_APP_CREATION_ROUND}`,
    )
  }

  console.log(`[reti] scanning events [${RETI_APP_CREATION_ROUND}, ${targetRound})…`)
  const { events, epochRoundLengths } = await fetchRetiEvents(
    indexer,
    registryAppId,
    RETI_APP_CREATION_ROUND,
    targetRound,
  )
  const poolCount = new Set(events.map((event) => event.poolAppId)).size
  console.log(`  ${events.length} events from ${epochRoundLengths.size} validators and ${poolCount} pools`)

  const pools: PoolLedger = new Map()
  for (const event of events) applyRetiEvent(pools, event, epochRoundLengths)

  logStakeStats(pools, targetRound)
  return createSnapshot(targetRound, pools)
}
