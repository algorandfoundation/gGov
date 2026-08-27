/**
 * Hand-checks for the registry-funding arithmetic in `src/lib/mbrEstimate.ts`.
 *
 * The box-size formula itself is pinned against the compiled ARC-56 specs in
 * `projects/contracts/smart_contracts/boxNames.spec.ts`. What that cannot reach is the composition
 * around it — chunk rounding, the delegation term, per-instance folding — because it lives in the
 * frontend, which has no test runner. Run with `pnpm tsx scripts/check-mbr-estimate.ts`.
 */
import { DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS, voteRecordBoxMbr, GGOV_VOTE_RECORD_KEY_LENGTH } from 'ggov-sdk'
import {
  countsTowardMbr,
  drainForChild,
  estimateFracRegistry,
  estimateGgovRegistry,
  spendable,
  splitUndelegated,
  votersAtTurnout,
} from '../src/lib/mbrEstimate'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${actual}, want ${expected}`}`)
}

// A 3-topic, 2-option ballot. topicVotes is flat, so only the 6 option cells reach the wire:
// value = 5 + 4*6 = 29; key 33; MBR = 2500 + 400*62 = 27_300.
const OPTS = [2, 2, 2]
check('voteRecordBoxMbr 3x2', voteRecordBoxMbr(GGOV_VOTE_RECORD_KEY_LENGTH, OPTS), 27_300n)

check('spendable above floor', spendable(1_000_000n, 400_000n), 600_000n)
check('spendable below floor floors at 0', spendable(100_000n, 400_000n), 0n)

// Chunk rounding: a 1 µAlgo shortfall still costs a whole 5 ALGO top-up.
check('drain rounds up to a whole chunk', drainForChild(5_000_001n, 5_000_000n, 5_000_000n), 5_000_000n)
check('drain of exactly one chunk', drainForChild(5_000_000n, 0n, 5_000_000n), 5_000_000n)
check('drain spanning two chunks', drainForChild(5_000_001n, 0n, 5_000_000n), 10_000_000n)
check('no drain when the child is covered', drainForChild(1_000n, 5_000n, 5_000_000n), 0n)

// Which periods count: ready and not yet ended. A draft is never priced, however imminent, and a
// ready period whose window has not opened yet is priced in full.
const NOW = 1_000_000
check('ready and still upcoming counts', countsTowardMbr({ ready: true, votingEnd: NOW + 86_400 }, NOW), true)
check('ready and mid-window counts', countsTowardMbr({ ready: true, votingEnd: NOW }, NOW), true)
check('ready but ended does not', countsTowardMbr({ ready: true, votingEnd: NOW - 1 }, NOW), false)
check('draft does not, however soon', countsTowardMbr({ ready: false, votingEnd: NOW + 86_400 }, NOW), false)

check('turnout rounds up', votersAtTurnout(101, 50), 51)
check('turnout 0 is 0', votersAtTurnout(101, 0), 0)
check('turnout clamps above 100', votersAtTurnout(10, 500), 10)

// Who can still delegate. A/B/C are gGov accounts, C/D/E are frac accounts (C is both), and B and
// D have already delegated. So gGov owes for A and C, and the pooled term owes for E alone —
// C never counts twice, and D is already paid for.
const split = splitUndelegated(['A', 'B', 'C'], ['C', 'D', 'E'], ['B', 'D'])
check('gGov undelegated nets off delegators', split.ggov, 2)
check('pooled undelegated excludes the overlap', split.pooled, 1)
const noFrac = splitUndelegated(['A', 'B'], [], [])
check('no frac registry means no pooled term', noFrac.pooled, 0)
check('a frac-only roster of delegators is empty', splitUndelegated([], ['D'], ['D']).pooled, 0)

// One period, 100 members, ballot above: 100 * 32_100 = 3_210_000 needed, child holds nothing,
// so one 5 ALGO chunk. Plus 10 undelegated gGov accounts * 57_800 = 578_000, and 4 pooled ones
// * 57_800 = 231_200 — same rate, same boxes, separate line.
const ggov = estimateGgovRegistry({
  periods: [{ periodId: 1, optionCounts: OPTS, members: 100, childSpendable: 0n }],
  undelegated: { ggov: 10, pooled: 4 },
  mbrTopUp: 5_000_000n,
  turnoutPct: 100,
})
check('ggov period drain', ggov.periods[0].drain, 5_000_000n)
check('ggov delegation need', ggov.delegationNeed, DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS * 10n)
check('ggov pooled delegation need', ggov.pooledDelegationNeed, DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS * 4n)
check('ggov required includes both delegation terms', ggov.required, 5_000_000n + 578_000n + 231_200n)
check('ggov resolved', ggov.resolved, true)

// Turnout scales voting but must leave the delegation term untouched.
const half = estimateGgovRegistry({
  periods: [{ periodId: 1, optionCounts: OPTS, members: 100, childSpendable: 0n }],
  undelegated: { ggov: 10, pooled: 4 },
  mbrTopUp: 5_000_000n,
  turnoutPct: 50,
})
check('turnout does not scale delegation', half.delegationNeed, ggov.delegationNeed)
check('turnout does not scale pooled delegation', half.pooledDelegationNeed, ggov.pooledDelegationNeed)
check('half turnout halves the voter count', half.periods[0].voters, 50)

// An unresolved child balance must not read as "covered".
const pending = estimateGgovRegistry({
  periods: [{ periodId: 1, optionCounts: OPTS, members: 1, childSpendable: undefined }],
  undelegated: { ggov: 0, pooled: 0 },
  mbrTopUp: 5_000_000n,
  turnoutPct: 100,
})
check('unresolved child is flagged', pending.resolved, false)

// Two periods on one instance fold into a single chunk-rounded drain, not one chunk each.
const frac = estimateFracRegistry({
  pools: [
    { instanceNumId: 1, name: 'Pool A', members: 10, perVoter: 10_000n, childSpendable: 0n },
    { instanceNumId: 1, name: 'Pool A', members: 10, perVoter: 10_000n, childSpendable: 0n },
  ],
  mbrTopUp: 2_000_000n,
  turnoutPct: 100,
})
check('frac folds periods per instance', frac.instances.length, 1)
check('frac instance need', frac.instances[0].need, 200_000n)
check('frac drain is one chunk, not two', frac.required, 2_000_000n)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
