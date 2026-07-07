/**
 * Verify the event replay against live chain state.
 *
 * Replays registry events from the latest committed snapshot and compares each pool's
 * stakers (balance and entryRound) against its live `stakers` box. The registry's
 * `staked` global is also checked for completeness. Exits non-zero on any difference:
 * the replay and the chain disagree.
 *
 * Usage:
 *   pnpm verify:reti
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { encodeAddress } from 'algosdk'

import { indexerClient, withRetry } from '../indexer'
import { RETI_APP_ID } from './constants'
import { fetchRetiEvents } from './indexer'
import { applyRetiEvent, totalStaked } from './ledger'
import { deserializePools, latestSnapshotRound, readSnapshot } from './snapshot/operations'
import type { PoolLedger, RetiEvent, StakerInfo } from './types'

const STAKER_SLOT_SIZE = 64
const BOX_FETCH_BATCH_SIZE = 50
const ZERO_ACCOUNT = Buffer.alloc(32)

type LiveBox = { stakers: Map<string, StakerInfo>; round: bigint }

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

function sumBalances(stakers: Map<string, StakerInfo>): bigint {
  let total = 0n
  for (const { balance } of stakers.values()) total += balance
  return total
}

// Conservative ceiling for accumulated rounding drift (see splitReward in ledger.ts);
// differences above 1,000 microALGO are treated as replay errors.
const DRIFT_TOLERANCE = 1_000n

/** Decode a pool's `stakers` box: 200 fixed slots of (account, balance, …, entryRound). */
function decodeStakersBox(value: Uint8Array): Map<string, StakerInfo> {
  const box = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const stakers = new Map<string, StakerInfo>()
  for (let offset = 0; offset + STAKER_SLOT_SIZE <= box.length; offset += STAKER_SLOT_SIZE) {
    const account = box.subarray(offset, offset + 32)
    if (account.equals(ZERO_ACCOUNT)) continue
    stakers.set(encodeAddress(account), {
      balance: box.readBigUInt64BE(offset + 32),
      entryRound: Number(box.readBigUInt64BE(offset + 56)),
    })
  }
  return stakers
}

/**
 * Fetch every pool's live `stakers` box, keeping the round each box was served at.
 * Concurrent, so the boxes land within a round or two of each other.
 */
async function fetchLiveBoxes(poolAppIds: Iterable<bigint>): Promise<Map<bigint, LiveBox>> {
  const ids = [...poolAppIds]
  const live = new Map<bigint, LiveBox>()

  for (let offset = 0; offset < ids.length; offset += BOX_FETCH_BATCH_SIZE) {
    const entries = await Promise.all(
      ids.slice(offset, offset + BOX_FETCH_BATCH_SIZE).map(async (poolAppId) => {
        const box = await withRetry(() =>
          indexerClient.lookupApplicationBoxByIDandName(poolAppId, Buffer.from('stakers')).do(),
        )
        return [poolAppId, { stakers: decodeStakersBox(box.value), round: box.round }] as const
      }),
    )
    for (const [poolAppId, box] of entries) live.set(poolAppId, box)
  }

  return live
}

/** The registry's protocol-wide `staked` total — an aggregate independent of our event-derived pool set. */
async function fetchRegistryTotalStaked(): Promise<{ staked: bigint; round: bigint }> {
  const data = await withRetry(() => indexerClient.lookupApplications(RETI_APP_ID).do())
  for (const entry of data.application?.params.globalState ?? []) {
    if (Buffer.from(entry.key).equals(Buffer.from('staked')))
      return { staked: entry.value.uint, round: data.currentRound }
  }
  throw new Error('Registry global state has no `staked` key')
}

/** How the registry's `staked` global moves with an event (event amounts, not our residue-adjusted deltas). */
function registryDelta(event: RetiEvent): bigint {
  switch (event.type) {
    case 'stakeAdded':
      return event.amount
    case 'stakeRemoved':
      return -event.amount
    case 'epochRewardUpdate':
      return event.algoAdded
  }
}

/** Compare one replayed pool against its live box: balances within drift, entry rounds exact. */
function comparePool(
  poolAppId: bigint,
  stored: Map<string, StakerInfo>,
  chain: Map<string, StakerInfo>,
): { errors: string[]; maxDrift: bigint } {
  const errors: string[] = []
  let maxDrift = 0n

  const storedTotal = sumBalances(stored)
  const chainTotal = sumBalances(chain)
  if (absDiff(storedTotal, chainTotal) > DRIFT_TOLERANCE) {
    errors.push(`pool ${poolAppId} total staked ${chainTotal} differs from our stored ${storedTotal}`)
  }

  for (const staker of new Set([...stored.keys(), ...chain.keys()])) {
    const storedBal = stored.get(staker)
    const liveBal = chain.get(staker)
    const drift = absDiff(storedBal?.balance ?? 0n, liveBal?.balance ?? 0n)
    if (drift > maxDrift) maxDrift = drift
    if (drift > DRIFT_TOLERANCE) {
      errors.push(
        `pool ${poolAppId} ${staker} balance ${liveBal?.balance ?? 0n} differs from our stored ${storedBal?.balance ?? 0n}`,
      )
    }
    if (storedBal && liveBal && storedBal.entryRound !== liveBal.entryRound) {
      errors.push(`pool ${poolAppId} ${staker} entryRound ${liveBal.entryRound}→${storedBal.entryRound}`)
    }
  }

  return { errors, maxDrift }
}

async function main() {
  const baseRound = latestSnapshotRound()
  console.log(`\nVerifying reti replay against live chain state (base snapshot: ${baseRound})\n`)

  const storedPools = deserializePools(readSnapshot(baseRound))
  const storedTotalStaked = totalStaked(storedPools)

  // The registry lookup doubles as the "current round" source that bounds the scan
  const registry = await fetchRegistryTotalStaked()
  const scannedTo = registry.round
  console.log(`Scanning events [${baseRound}, ${scannedTo + 1n})…`)
  const { events, epochRoundLengths } = await fetchRetiEvents(baseRound, scannedTo + 1n)

  const poolAppIds = new Set([...storedPools.keys(), ...events.map((event) => event.poolAppId)])
  console.log(`\nFetching ${poolAppIds.size} live stakers boxes…`)
  const liveBoxes = await fetchLiveBoxes(poolAppIds)

  // Boxes can be served past the scan; extend it once so every pool's events reach its
  // box's round. Pools born past the scanned round have no box here and are out of scope.
  let latestBoxRound = scannedTo
  for (const { round } of liveBoxes.values()) if (round > latestBoxRound) latestBoxRound = round
  if (latestBoxRound > scannedTo) {
    const late = await fetchRetiEvents(scannedTo + 1n, latestBoxRound + 1n)
    events.push(...late.events)
    for (const [validatorId, length] of late.epochRoundLengths) epochRoundLengths.set(validatorId, length)
  }

  // Completeness at the registry's own round: its total must equal base + event deltas
  let expectedStaked = storedTotalStaked
  for (const event of events) {
    if (BigInt(event.round) <= registry.round) expectedStaked += registryDelta(event)
  }
  if (absDiff(expectedStaked, registry.staked) > DRIFT_TOLERANCE) {
    throw new Error(
      `Registry reports ${registry.staked} microALGO staked at round ${registry.round} but the snapshot plus ` +
        `event deltas gives ${expectedStaked} — the scan missed events (possibly a whole pool's) or ` +
        'double-counted some; investigate.',
    )
  }

  // Replay each pool to the exact round its box was served at, then compare
  const eventsByPool = new Map<bigint, RetiEvent[]>()
  for (const event of events) {
    let poolEvents = eventsByPool.get(event.poolAppId)
    if (!poolEvents) eventsByPool.set(event.poolAppId, (poolEvents = []))
    poolEvents.push(event)
  }

  const errors: string[] = []
  let maxDrift = 0n
  for (const [poolAppId, box] of liveBoxes) {
    const ledger: PoolLedger = new Map([[poolAppId, storedPools.get(poolAppId) ?? new Map<string, StakerInfo>()]])
    for (const event of eventsByPool.get(poolAppId) ?? []) {
      if (BigInt(event.round) <= box.round) applyRetiEvent(ledger, event, epochRoundLengths)
    }
    const compared = comparePool(poolAppId, ledger.get(poolAppId)!, box.stakers)
    errors.push(...compared.errors)
    if (compared.maxDrift > maxDrift) maxDrift = compared.maxDrift
  }

  if (errors.length > 0) {
    throw new Error(`${errors.length} difference(s) against the chain:\n  ${errors.join('\n  ')}`)
  }
  console.log(
    `\n✓ Replay matches the chain across ${liveBoxes.size} pools, each at its box's round: ` +
      `registry total accounted for, entry rounds exact, max per-staker drift ${maxDrift} microALGO (flooring ambiguity)`,
  )
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
