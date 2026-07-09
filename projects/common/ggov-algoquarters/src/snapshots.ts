/** Shared snapshot persistence and verify-first snapshot chaining. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SNAPSHOT_INTERVAL } from './config'
import { stringifyJson } from './utils/json'

/** File persistence for a snapshots directory: path, read (with a regenerate hint), write, latest round. */
export function createSnapshotFiles<Snapshot extends { round: number }>(snapshotsDir: string, regenerateCmd: string) {
  function getSnapshotPath(round: bigint | number): string {
    return join(snapshotsDir, `${round}.json`)
  }

  function readSnapshot(round: bigint | number): Snapshot {
    const path = getSnapshotPath(round)
    if (!existsSync(path)) {
      throw new Error(`Snapshot not found: ${path}\nRun: ${regenerateCmd} ${round}`)
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as Snapshot
  }

  function writeSnapshot(snapshot: Snapshot): string {
    const path = getSnapshotPath(snapshot.round)
    mkdirSync(snapshotsDir, { recursive: true })
    writeFileSync(path, stringifyJson(snapshot))
    return path
  }

  function latestSnapshotRound(): bigint {
    const rounds = existsSync(snapshotsDir)
      ? readdirSync(snapshotsDir)
          .filter((name) => /^\d+\.json$/.test(name))
          .map((name) => BigInt(name.replace('.json', '')))
      : []
    if (rounds.length === 0) throw new Error(`No snapshot found in ${snapshotsDir}\nRun: ${regenerateCmd} <round>`)
    return rounds.reduce((max, round) => (round > max ? round : max))
  }

  return { getSnapshotPath, readSnapshot, writeSnapshot, latestSnapshotRound }
}

/** Snapshot operations a pipeline provides for checking and creating snapshots. */
export interface SnapshotStore<State, Snapshot extends { round: number }> {
  getSnapshotPath(round: bigint | number): string
  readSnapshot(round: bigint | number): Snapshot
  createSnapshot(round: bigint, state: State): Snapshot
  diffSnapshot(state: State, stored: Snapshot): string[]
}

/**
 * Verify computed state against an existing snapshot, or build the snapshot
 * to persist later. Throws on mismatch so the caller can abort before writing
 * any output derived from a non-matching replay.
 */
function checkOrCreateSnapshot<State, Snapshot extends { round: number }>(
  store: SnapshotStore<State, Snapshot>,
  round: bigint,
  state: State,
): Snapshot | null {
  if (existsSync(store.getSnapshotPath(round))) {
    const diffs = store.diffSnapshot(state, store.readSnapshot(round))
    if (diffs.length > 0) {
      throw new Error(
        `Snapshot ${round}.json has ${diffs.length} mismatch(es):\n${diffs.join('\n')}\n` +
          'Stored snapshot and this scan disagree — nothing was written; investigate before trusting either.',
      )
    }
    console.log(`  ✓ ${round}: snapshot exists and matches`)
    return null
  }
  return store.createSnapshot(round, state)
}

/**
 * Check or build snapshots (multiples of SNAPSHOT_INTERVAL) in the window (periodStart, periodEnd],
 * advancing `state` by replaying `items` (chronologically ordered) up to each snapshot round.
 * Verification runs before anything is persisted: a mismatch throws with nothing written.
 * Returns the missing snapshots for the caller to persist once every round verified.
 */
export function checkOrCreateSnapshots<State, Snapshot extends { round: number }, Item extends { round: number }>(
  store: SnapshotStore<State, Snapshot>,
  state: State,
  items: Item[],
  applyItem: (state: State, item: Item) => void,
  periodStart: bigint,
  periodEnd: bigint,
): Snapshot[] {
  console.log('\nChecking snapshots…')
  if (periodStart % SNAPSHOT_INTERVAL !== 0n) {
    console.warn(`Warning: periodStart is not multiple of ${SNAPSHOT_INTERVAL}`)
  }

  const pendingSnapshots: Snapshot[] = []
  const first = (periodStart / SNAPSHOT_INTERVAL + 1n) * SNAPSHOT_INTERVAL
  let itemIdx = 0

  for (let snapshotRound = first; snapshotRound <= periodEnd; snapshotRound += SNAPSHOT_INTERVAL) {
    while (itemIdx < items.length && BigInt(items[itemIdx].round) < snapshotRound) {
      applyItem(state, items[itemIdx])
      itemIdx++
    }
    const snapshot = checkOrCreateSnapshot(store, snapshotRound, state)
    if (snapshot) pendingSnapshots.push(snapshot)
  }

  return pendingSnapshots
}
