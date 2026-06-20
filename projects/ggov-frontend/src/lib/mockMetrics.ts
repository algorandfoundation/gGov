/**
 * Placeholder governance metrics that the SDK does not yet expose on-chain.
 *
 * TODO(FLAG): replace every value here with real SDK reads. Specifically:
 *  - per-period turnout (unique wallets that voted + % participation) needs a new
 *    GGovReaderSDK method, e.g. `getPeriodTurnout(periodId)`, scanning the period
 *    app's vote-record boxes (per-option tallies live in `period.topics`, but the
 *    unique-wallet count does not), surfaced through a `usePeriodTurnout` hook.
 *  - average participation is the aggregate of the above across periods.
 *
 * (Producer rank percentile is now real — see the `useProducerRank` hook, which
 * derives it client-side from `registry.getCommitteeXGovs`.)
 *
 * Values are deterministic per period id so the UI is stable across renders.
 */

export interface MockTurnout {
  /** Participation percentage, 0–100. */
  turnoutPct: number
  /** Number of distinct wallets that have voted. */
  walletsVoted: number
}

/** Deterministic pseudo-turnout derived from the period id. */
export function mockPeriodTurnout(periodId: number, eligibleVoters?: number): MockTurnout {
  // Simple stable hash → 20–75% turnout band.
  const seed = (periodId * 2654435761) >>> 0
  const turnoutPct = 20 + (seed % 56)
  const base = eligibleVoters && eligibleVoters > 0 ? eligibleVoters : 3200
  const walletsVoted = Math.round((turnoutPct / 100) * base)
  return { turnoutPct, walletsVoted }
}

/** Placeholder average participation across all periods. */
export const MOCK_AVERAGE_PARTICIPATION_PCT = 63
