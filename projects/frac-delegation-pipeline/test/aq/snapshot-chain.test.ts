/**
 * Snapshot chaining driven by the replay itself.
 *
 * The rule the whole scheme rests on: a snapshot at round `R` is the state with every item of round
 * `< R` applied, and nothing else. These pin that against a replay that reports its own boundary
 * crossings, which is what replaced replaying the window a second time over a copy of the state.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { SNAPSHOT_INTERVAL, createSnapshotChain, type SnapshotStore } from '../../src/aq/index.ts'

const MILLION = Number(SNAPSHOT_INTERVAL)

/** State is a running list of the item rounds applied so far; a snapshot freezes a copy of it. */
type State = { applied: number[] }
type Snap = { round: number; applied: number[] }

function makeStore(dir: string): SnapshotStore<State, Snap> {
  return {
    getSnapshotPath: (round) => join(dir, `${round}.json`),
    readSnapshot: (round) => ({ round: Number(round), applied: [] }),
    // A real store serializes into fresh objects; copying the array is the same guarantee
    createSnapshot: (round, state) => ({ round: Number(round), applied: [...state.applied] }),
    diffSnapshot: (state, stored) =>
      JSON.stringify(state.applied) === JSON.stringify(stored.applied) ? [] : ['mismatch'],
    toState: (snapshot) => ({ applied: [...snapshot.applied] }),
  }
}

/** Replay `rounds` through the chain the way the compute functions do: report, then apply. */
function replay(store: SnapshotStore<State, Snap>, rounds: number[], periodStart: bigint, periodEnd: bigint) {
  const state: State = { applied: [] }
  const chain = createSnapshotChain(store, state, periodStart, periodEnd)
  for (const round of rounds) {
    chain.recorder.crossing(round)
    state.applied.push(round)
  }
  chain.recorder.finish()
  return chain
}

describe('createSnapshotChain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aq-chain-'))
  const store = makeStore(dir)

  it('captures each boundary with exactly the items below it applied', () => {
    const rounds = [1_000, MILLION - 1, MILLION, MILLION + 5, 2 * MILLION, 2 * MILLION + 1]
    const pending = replay(store, rounds, 0n, BigInt(3 * MILLION)).verify()

    expect(pending.map((s) => s.round)).toEqual([MILLION, 2 * MILLION, 3 * MILLION])
    // everything strictly below the boundary, and nothing at or above it
    expect(pending[0].applied).toEqual([1_000, MILLION - 1])
    expect(pending[1].applied).toEqual([1_000, MILLION - 1, MILLION, MILLION + 5])
    expect(pending[2].applied).toEqual(rounds)
  })

  it('gives boundaries past the last item the final state', () => {
    const pending = replay(store, [10, 20], 0n, BigInt(2 * MILLION)).verify()

    expect(pending.map((s) => s.round)).toEqual([MILLION, 2 * MILLION])
    for (const snapshot of pending) expect(snapshot.applied).toEqual([10, 20])
  })

  it('captures every boundary a single item skips over', () => {
    // one item at 2.5M crosses both the 1M and the 2M boundary at once
    const pending = replay(store, [500, 2 * MILLION + 500_000], 0n, BigInt(3 * MILLION)).verify()

    expect(pending.map((s) => s.round)).toEqual([MILLION, 2 * MILLION, 3 * MILLION])
    expect(pending[0].applied).toEqual([500])
    expect(pending[1].applied).toEqual([500])
    expect(pending[2].applied).toEqual([500, 2 * MILLION + 500_000])
  })

  it('excludes periodStart and includes periodEnd', () => {
    const pending = replay(store, [], BigInt(MILLION), BigInt(3 * MILLION)).verify()
    expect(pending.map((s) => s.round)).toEqual([2 * MILLION, 3 * MILLION])
  })

  it('has no boundaries in a window that spans none', () => {
    const chain = replay(store, [MILLION + 1], BigInt(MILLION), BigInt(MILLION + 10))
    expect(chain.verify()).toEqual([])
  })

  it('refuses to verify a replay that never finished', () => {
    const state: State = { applied: [] }
    const chain = createSnapshotChain(store, state, 0n, BigInt(2 * MILLION))
    chain.recorder.crossing(10)
    expect(() => chain.verify()).toThrow(/never captured/)
  })

  it('skips a stored snapshot that matches, and throws on one that does not', () => {
    const matchDir = mkdtempSync(join(tmpdir(), 'aq-chain-match-'))
    const matching = makeStore(matchDir)
    // a stored snapshot at 1M holding what the replay will hold there
    writeFileSync(join(matchDir, `${MILLION}.json`), '{}')
    const stored: Snap = { round: MILLION, applied: [7] }
    const pending = replay(
      { ...matching, readSnapshot: () => stored },
      [7, MILLION + 1],
      0n,
      BigInt(2 * MILLION),
    ).verify()
    // 1M matched the file on disk, so only 2M is left to write
    expect(pending.map((s) => s.round)).toEqual([2 * MILLION])

    const disagreeing: Snap = { round: MILLION, applied: [999] }
    expect(() =>
      replay({ ...matching, readSnapshot: () => disagreeing }, [7, MILLION + 1], 0n, BigInt(2 * MILLION)).verify(),
    ).toThrow(/disagree/)
  })
})
