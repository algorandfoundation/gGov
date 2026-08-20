/** Shared snapshot persistence and verify-first snapshot chaining. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SNAPSHOT_INTERVAL } from './config.ts'
import { stringifyJson } from './utils/json.ts'

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
  /** Rebuild replay state from a snapshot — the inverse of `createSnapshot`. */
  toState(snapshot: Snapshot): State
}

/**
 * Verify a computed snapshot against the one on disk, or hand it back to persist later. Throws on
 * mismatch so the caller can abort before writing any output derived from a non-matching replay.
 * @returns the snapshot to persist, or null when a matching one is already stored
 */
function checkStoredSnapshot<State, Snapshot extends { round: number }>(
  store: SnapshotStore<State, Snapshot>,
  computed: Snapshot,
): Snapshot | null {
  const round = BigInt(computed.round)
  if (existsSync(store.getSnapshotPath(round))) {
    const diffs = store.diffSnapshot(store.toState(computed), store.readSnapshot(round))
    if (diffs.length > 0) {
      throw new Error(
        `Snapshot ${round}.json has ${diffs.length} mismatch(es):\n${diffs.join('\n')}\n` +
          'Stored snapshot and this scan disagree — nothing was written; investigate before trusting either.',
      )
    }
    console.log(`  ✓ ${round}: snapshot exists and matches`)
    return null
  }
  return computed
}

/**
 * The snapshot rounds a window covers: the `SNAPSHOT_INTERVAL` multiples in
 * `(periodStart, periodEnd]`, ascending.
 */
export function snapshotRoundsIn(periodStart: bigint, periodEnd: bigint): bigint[] {
  const rounds: bigint[] = []
  const first = (periodStart / SNAPSHOT_INTERVAL + 1n) * SNAPSHOT_INTERVAL
  for (let round = first; round <= periodEnd; round += SNAPSHOT_INTERVAL) rounds.push(round)
  return rounds
}

/**
 * What a replay reports its progress to, so state can be captured at the snapshot boundaries it
 * crosses.
 *
 * `crossing(round)` must be called immediately **before** applying each item, in replay order, and
 * `finish()` once every item has been applied. That is exactly the rule the snapshots follow: the
 * state at round `R` is every item with `round < R` applied and nothing else.
 */
export interface BoundaryRecorder {
  crossing(round: number): void
  finish(): void
}

/** A recorder that captures nothing — for a replay that is not building snapshots. */
export const NO_BOUNDARIES: BoundaryRecorder = {
  crossing() {},
  finish() {},
}

/**
 * Verify-first snapshot chaining, driven by the replay that computes the AlgoQuarters rather than by
 * a second replay of its own.
 *
 * Hand `recorder` to the compute function and call `verify()` once it returns. Each of a window's
 * `SNAPSHOT_INTERVAL` boundaries is captured off the live `state` as the replay crosses it — the
 * compute functions apply the very same ledger mutations, in the same order, that a separate replay
 * would, and `store.createSnapshot` serializes into fresh objects, so the captures are independent
 * of the mutations that follow.
 *
 * Verification runs in `verify()`, before anything is persisted: a stored snapshot that disagrees
 * with this replay throws with nothing written, and the missing ones are returned for the caller to
 * persist.
 */
export function createSnapshotChain<State, Snapshot extends { round: number }>(
  store: SnapshotStore<State, Snapshot>,
  state: State,
  periodStart: bigint,
  periodEnd: bigint,
): { recorder: BoundaryRecorder; verify: () => Snapshot[] } {
  if (periodStart % SNAPSHOT_INTERVAL !== 0n) {
    console.warn(`Warning: periodStart is not multiple of ${SNAPSHOT_INTERVAL}`)
  }

  const rounds = snapshotRoundsIn(periodStart, periodEnd)
  const captured: Snapshot[] = []
  let next = 0

  /** Capture every boundary at or below `round` — or all that are left, when `round` is undefined. */
  function captureUpTo(round?: number): void {
    while (next < rounds.length && (round === undefined || rounds[next] <= BigInt(round))) {
      captured.push(store.createSnapshot(rounds[next], state))
      next++
    }
  }

  return {
    recorder: {
      crossing: (round) => captureUpTo(round),
      finish: () => captureUpTo(),
    },
    verify() {
      if (next < rounds.length) {
        throw new Error(
          `Snapshot chain was not finished: ${rounds.length - next} of ${rounds.length} boundaries were ` +
            'never captured — the replay did not call finish()',
        )
      }
      console.log('\nChecking snapshots…')
      const pendingSnapshots: Snapshot[] = []
      for (const snapshot of captured) {
        const pending = checkStoredSnapshot(store, snapshot)
        if (pending) pendingSnapshots.push(pending)
      }
      return pendingSnapshots
    },
  }
}
