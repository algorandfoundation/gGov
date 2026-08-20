import { useMemo } from 'react'
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

  return useMemo(() => {
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

    const started = new Set(
      periods.filter((p) => p.ready && p.period.votingStart * 1000 <= Date.now()).map((p) => p.id),
    )
    const startedOn = (committeeIdBase64Url: string | undefined) =>
      (committeeIdBase64Url ? (byCommittee.get(committeeIdBase64Url) ?? []) : []).filter((id) => started.has(id))

    return { periodLabels, byCommittee, startedOn }
  }, [periods])
}
