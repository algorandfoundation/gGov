import type { GGovPeriod } from 'ggov-sdk'

/** Whether any vote has been cast against any of the period's topics. */
export function periodHasVotes(period: GGovPeriod): boolean {
  return period.topics.some(([, tallies]) => tallies.some((t) => t > 0))
}

/**
 * A ready period with votes cast is frozen for good: the contract blocks
 * `setReady(false)` once a vote lands, so it can never return to draft and nothing
 * about it is editable again. Such a period gets no Edit button and no mode toggle.
 */
export function periodFrozen(period: GGovPeriod, ready: boolean): boolean {
  return ready && periodHasVotes(period)
}
