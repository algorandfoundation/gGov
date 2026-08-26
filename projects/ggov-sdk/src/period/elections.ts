import type { Election, TopicBodyJson } from './types.js'

/**
 * Grouping a period's topics into its elections, and checking that grouping before
 * the period is frozen with `setReady`.
 *
 * A period holds one shared ballot — one committee, one voting window, one `vote()`
 * over every topic. "Which election is this candidate running in" is off-chain
 * metadata: the period body lists the elections (`elect`) and each candidate's own
 * topic body names one by index (`e`). Nothing here touches the chain; these are
 * pure functions over data the results and manage views already fetch.
 */

/** A topic as the reader returns it: option labels and their parallel tallies. */
export type TopicTuple = [string[], number[]]

/** A candidate placed into an election by {@link groupCandidates}. */
export interface GroupedCandidate {
  /** Index into the period's `topics` array — the handle every write API takes. */
  topicIndex: number
  /** The topic body's title, or null when the body is missing or unreadable. */
  name: string | null
  options: string[]
  tallies: number[]
}

/** One election together with the candidates tagged to it. */
export interface CandidateGroup {
  /** Index into the period body's `elect` — the value candidates carry as `e`. */
  electionIndex: number
  election: Election
  candidates: GroupedCandidate[]
}

/**
 * Bucket a period's topics into its elections by each topic body's `e` tag.
 *
 * Returns one group per declared election, in `elect` order, including elections
 * that ended up with no candidates — the caller decides how to present an empty
 * race. Candidates whose tag is missing or names no declared election are **left
 * out** rather than folded into the first election; {@link validateAssignment}
 * reports them, so a mis-tagged candidate surfaces as an authoring error instead of
 * quietly entering the wrong race.
 *
 * `topicBodies` is indexed in parallel with `topics` (as the readers return them);
 * a missing entry is treated as an untagged candidate.
 */
export function groupCandidates(
  topics: readonly TopicTuple[],
  topicBodies: readonly (TopicBodyJson | null | undefined)[],
  elect: readonly Election[],
): CandidateGroup[] {
  const groups: CandidateGroup[] = elect.map((election, electionIndex) => ({
    electionIndex,
    election,
    candidates: [],
  }))
  topics.forEach(([options, tallies], topicIndex) => {
    const body = topicBodies[topicIndex]
    const e = body?.e
    if (e === undefined || e < 0 || e >= groups.length) return
    groups[e].candidates.push({ topicIndex, name: body?.title ?? null, options, tallies })
  })
  return groups
}

/** A candidate that can't be placed into a declared election. */
export interface AssignmentProblem {
  topicIndex: number
  name: string | null
  /** `unassigned` — no `e` at all; `outOfRange` — `e` names no declared election. */
  kind: 'unassigned' | 'outOfRange'
  /** The offending tag, present only for `outOfRange`. */
  e?: number
}

/** An election whose seat count isn't backed by enough candidates. */
export interface SeatProblem {
  electionIndex: number
  title: string
  seats: number
  candidates: number
}

/** The result of {@link validateAssignment} — everything blocking a clean `setReady`. */
export interface AssignmentReport {
  /** Candidates with a missing or undeclared election tag. */
  problems: AssignmentProblem[]
  /** Indexes of declared elections that no candidate joined — nothing to rank. */
  emptyElections: number[]
  /** Elections asking to seat more candidates than are running (`s` > candidates). */
  seatShortfalls: SeatProblem[]
  /** True when none of the above fired. */
  ok: boolean
}

/**
 * Cross-check a period's candidate tags against its declared elections. This is the
 * gate the operator UI runs before `setReady`: once a period is ready and a vote
 * lands, the topic set is frozen, so a mis-tagged candidate can no longer be fixed.
 *
 * Only meaningful for election periods (`elect` present and non-empty); pass a
 * standard period's absent `elect` and every topic is reported unassigned, which is
 * why callers should check for an election period first.
 */
export function validateAssignment(
  topicBodies: readonly (TopicBodyJson | null | undefined)[],
  elect: readonly Election[],
): AssignmentReport {
  const problems: AssignmentProblem[] = []
  const counts = elect.map(() => 0)

  topicBodies.forEach((body, topicIndex) => {
    const name = body?.title ?? null
    const e = body?.e
    if (e === undefined) {
      problems.push({ topicIndex, name, kind: 'unassigned' })
    } else if (e < 0 || e >= elect.length) {
      problems.push({ topicIndex, name, kind: 'outOfRange', e })
    } else {
      counts[e]++
    }
  })

  const emptyElections = elect.map((_, i) => i).filter((i) => counts[i] === 0)
  const seatShortfalls = elect.flatMap((election, electionIndex) =>
    counts[electionIndex] > 0 && election.s > counts[electionIndex]
      ? [{ electionIndex, title: election.t, seats: election.s, candidates: counts[electionIndex] }]
      : [],
  )

  return {
    problems,
    emptyElections,
    seatShortfalls,
    ok: problems.length === 0 && emptyElections.length === 0 && seatShortfalls.length === 0,
  }
}

/**
 * Render an {@link AssignmentReport} as operator-facing warning lines, for the
 * pre-`setReady` checklist. Keeps the phrasing in one place instead of duplicating
 * it across the manage views.
 */
export function describeAssignmentReport(report: AssignmentReport, elect: readonly Election[]): string[] {
  const label = (topicIndex: number, name: string | null) => name?.trim() || `candidate ${topicIndex + 1}`
  const lines: string[] = []

  const unassigned = report.problems.filter((p) => p.kind === 'unassigned')
  if (unassigned.length > 0) {
    lines.push(
      `${unassigned.length === 1 ? 'a candidate is' : `${unassigned.length} candidates are`} not assigned to an election (${unassigned.map((p) => label(p.topicIndex, p.name)).join(', ')})`,
    )
  }

  for (const p of report.problems.filter((p) => p.kind === 'outOfRange')) {
    lines.push(`${label(p.topicIndex, p.name)} is assigned to election #${(p.e ?? 0) + 1}, which doesn't exist`)
  }

  for (const i of report.emptyElections) {
    lines.push(`election "${elect[i]?.t ?? i + 1}" has no candidates`)
  }

  for (const s of report.seatShortfalls) {
    lines.push(
      `election "${s.title}" elects ${s.seats} seat${s.seats === 1 ? '' : 's'} but has only ${s.candidates} candidate${s.candidates === 1 ? '' : 's'}`,
    )
  }

  return lines
}
