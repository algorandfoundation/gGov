import { useEffect, useMemo, useState } from 'react'
import { usePeriods, toBase64Url } from '@/hooks/queries'

export interface CommitteePeriods {
  /** Committee id (base64url) → "Period 19" / "Periods 18, 19". Absent when none used it. */
  periodLabels: Map<string, string>
  /** Committee id (base64url) → the period ids that ran on that window, ascending. */
  byCommittee: Map<string, number[]>
  /**
   * The periods on a committee whose voting has actually opened, ascending.
   *
   * The distinction matters wherever a figure is scoped to a ballot: a committee
   * can back several periods, and defaulting to the newest would report a flat 0%
   * for one that hasn't started — which reads as "nobody voted" rather than
   * "there was nothing to vote on".
   */
  startedOn: (committeeIdBase64Url: string | undefined) => number[]
}

/**
 * Which periods ran on each committee, and how to label a committee by them.
 *
 * A committee is a block window; a period is a ballot held against one. The
 * pooled surfaces both need the mapping — the index to label its committee
 * picker and scope turnout, the pool page to scope its voting record — so it is
 * derived once here from the period list they already load.
 */
export function useCommitteePeriods(): CommitteePeriods {
  const { data: periods = [] } = usePeriods()
  // `startedOn` compares against the wall clock, and a memo keyed only on
  // `periods` would freeze that comparison at the moment the list arrived: a page
  // left open as voting opens would keep reporting the period as not started, and
  // its turnout/tally queries would stay disabled until an unrelated refetch.
  // Bumping this re-runs the memo on the boundary itself.
  const [tick, setTick] = useState(0)

  const { periodLabels, byCommittee, startedOn, nextStart } = useMemo(() => {
    const byCommittee = new Map<string, number[]>()
    for (const p of periods) {
      const id = toBase64Url(p.period.committeeId)
      const list = byCommittee.get(id) ?? []
      list.push(p.id)
      byCommittee.set(id, list)
    }
    const periodLabels = new Map<string, string>()
    for (const [id, list] of byCommittee) {
      list.sort((a, b) => a - b)
      periodLabels.set(id, list.length === 1 ? `Period ${list[0]}` : `Periods ${list.join(', ')}`)
    }

    const now = Date.now()
    const started = new Set(periods.filter((p) => p.ready && p.period.votingStart * 1000 <= now).map((p) => p.id))
    const startedOn = (committeeIdBase64Url: string | undefined) =>
      (committeeIdBase64Url ? (byCommittee.get(committeeIdBase64Url) ?? []) : []).filter((id) => started.has(id))

    // The earliest boundary still ahead of us — what the timer below waits for.
    const upcoming = periods
      .filter((p) => p.ready && p.period.votingStart * 1000 > now)
      .map((p) => p.period.votingStart * 1000)
    const nextStart = upcoming.length > 0 ? Math.min(...upcoming) : undefined

    return { periodLabels, byCommittee, startedOn, nextStart }
    // `tick` is a dependency on purpose: it is how the clock re-enters the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, tick])

  useEffect(() => {
    if (nextStart === undefined) return
    // Clamped, for two reasons: `setTimeout` overflows past 2^31 ms and would
    // fire immediately in a loop, and a long wait is better re-armed than trusted
    // to survive a suspended tab. Each wake re-derives the memo, which either
    // moves the period into `started` or schedules the next leg.
    const delay = Math.min(Math.max(nextStart - Date.now(), 0) + 1_000, 6 * 60 * 60 * 1_000)
    const timer = setTimeout(() => setTick((t) => t + 1), delay)
    return () => clearTimeout(timer)
  }, [nextStart, tick])

  return { periodLabels, byCommittee, startedOn }
}
