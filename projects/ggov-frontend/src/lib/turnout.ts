import type { GGovPeriod } from 'ggov-sdk'

/**
 * Power-based turnout for a period: share of the committee's total voting power
 * that has been cast, 0–100. Every voter spends their full voting power on every
 * topic (enforced on-chain in `vote()`), so any topic's option-sum equals the
 * total power cast; take the max across topics to be robust to malformed/empty
 * topics. Returns null when it can't be computed (committee not loaded yet, no
 * voting power, or no topics).
 */
export function periodTurnoutPct(period: GGovPeriod, committeeTotalVotes?: number): number | null {
  if (!committeeTotalVotes || committeeTotalVotes <= 0) return null
  if (period.topics.length === 0) return null
  const cast = period.topics.reduce(
    (max, [, votes]) =>
      Math.max(
        max,
        votes.reduce((a, b) => a + b, 0),
      ),
    0,
  )
  return Math.min(100, Math.round((cast / committeeTotalVotes) * 100))
}
