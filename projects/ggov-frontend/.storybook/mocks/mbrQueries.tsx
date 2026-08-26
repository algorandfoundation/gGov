/**
 * Storybook mock for `@/hooks/mbrQueries`.
 *
 * Aliased in `.storybook/main.ts`, like the `queries` / `fracQueries` mocks, so
 * `RegistryFundingPanel` renders without an SDK, a signer, or algod — its real hook reads
 * application *account balances*, which no scenario fixture models.
 *
 * The estimate itself is NOT faked: stories supply the same inputs the real hook gathers (counted
 * periods, committee sizes, undelegated account counts, pool standings, balances) and this runs them through the
 * real `lib/mbrEstimate.ts`. So a story exercises the actual arithmetic and would break if the
 * estimator regressed — only the network is stubbed.
 */
import type { MbrEstimates } from '../../src/hooks/mbrQueries'
import {
  estimateFracRegistry,
  estimateGgovRegistry,
  shortfallOf,
  type CountedPeriod,
  type UndelegatedSplit,
  type CountedPool,
} from '../../src/lib/mbrEstimate'

export type { AppAccountInfo, MbrEstimates, RegistryMbr } from '../../src/hooks/mbrQueries'

/** What a story declares; everything else is derived by the real estimator. */
export interface MockMbrFixture {
  periods: CountedPeriod[]
  /** Accounts still able to delegate, by registry — `{ ggov, pooled }`. */
  undelegated: UndelegatedSplit
  mbrTopUp: bigint
  /** The gGov registry's own balance and floor. */
  ggovBalance: { amount: bigint; minBalance: bigint }
  /** Omit for a network with no frac registry — the panel then renders one column. */
  frac?: {
    pools: CountedPool[]
    mbrTopUp: bigint
    balance: { amount: bigint; minBalance: bigint }
  }
  isLoading?: boolean
  /** A balance read failed outright — the panel's provisional state, minus the loading spinner. */
  isError?: boolean
}

let fixture: MockMbrFixture | null = null

/** Set by a story's decorator before render — see `src/__stories__/RegistryFundingPanel.stories.tsx`. */
export function setMockMbrFixture(next: MockMbrFixture | null) {
  fixture = next
}

const GGOV_APP_ID = 1001n
const FRAC_APP_ID = 2002n

const EMPTY: MbrEstimates = {
  ggov: {
    appId: GGOV_APP_ID,
    amount: 0n,
    minBalance: 0n,
    spendable: 0n,
    required: 0n,
    shortfall: 0n,
    resolved: true,
    detail: {
      periods: [],
      undelegatedAccounts: 0,
      delegationNeed: 0n,
      undelegatedPooledAccounts: 0,
      pooledDelegationNeed: 0n,
      required: 0n,
      resolved: true,
    },
  },
  frac: null,
  countedPeriodCount: 0,
  isLoading: false,
  isError: false,
}

export function useMbrEstimates(turnoutPct: number): MbrEstimates {
  if (!fixture) return EMPTY

  const ggovDetail = estimateGgovRegistry({
    periods: fixture.periods,
    undelegated: fixture.undelegated,
    mbrTopUp: fixture.mbrTopUp,
    turnoutPct,
  })
  const ggovSpendable = fixture.ggovBalance.amount - fixture.ggovBalance.minBalance

  const frac = fixture.frac
  const fracDetail = frac ? estimateFracRegistry({ pools: frac.pools, mbrTopUp: frac.mbrTopUp, turnoutPct }) : null
  const fracSpendable = frac ? frac.balance.amount - frac.balance.minBalance : 0n

  return {
    ggov: {
      appId: GGOV_APP_ID,
      amount: fixture.ggovBalance.amount,
      minBalance: fixture.ggovBalance.minBalance,
      spendable: ggovSpendable,
      required: ggovDetail.required,
      shortfall: shortfallOf(ggovDetail.required, ggovSpendable),
      // The registry's own balance is always supplied by a fixture, so the only thing that can
      // leave this false is a child balance the story deliberately omitted (`childSpendable`
      // undefined) — which is exactly the provisional state the panel now has to handle.
      resolved: ggovDetail.resolved,
      detail: ggovDetail,
    },
    frac:
      frac && fracDetail
        ? {
            appId: FRAC_APP_ID,
            amount: frac.balance.amount,
            minBalance: frac.balance.minBalance,
            spendable: fracSpendable,
            required: fracDetail.required,
            shortfall: shortfallOf(fracDetail.required, fracSpendable),
            resolved: fracDetail.resolved,
            detail: fracDetail,
          }
        : null,
    countedPeriodCount: fixture.periods.length,
    isLoading: fixture.isLoading ?? false,
    isError: fixture.isError ?? false,
  }
}
