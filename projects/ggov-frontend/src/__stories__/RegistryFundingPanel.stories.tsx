import type { Meta, StoryObj } from '@storybook/react'
import RegistryFundingPanel from '@/components/manage/RegistryFundingPanel'
import { setMockMbrFixture, type MockMbrFixture } from '../../.storybook/mocks/mbrQueries'

/**
 * The registry-funding panel at the top of `/manage` — worst-case MBR each registry must be able to
 * supply, against what it holds.
 *
 * The numbers are NOT hand-written: each story declares the same inputs the real hook gathers (counted
 * periods, committee sizes, undelegated account counts, pool standings, balances) and the mock runs them through
 * the real `lib/mbrEstimate.ts`. So these stories exercise the actual arithmetic — chunk rounding,
 * the delegation terms, per-instance folding — and would break if it regressed.
 *
 * Drag the turnout slider to watch the voting term move while the delegation term stays put; that
 * asymmetry is deliberate (the requirement is that every eligible account *can* delegate).
 */
const GGOV_MBR_TOPUP = 5_000_000n
const FRAC_MBR_TOPUP = 2_000_000n

/** A 6-topic, 4-option ballot — a realistic gGov period shape. */
const BALLOT = [4, 4, 4, 4, 4, 4]

/** Two ready periods on sizeable committees, each period app already holding a little. */
const COUNTED_PERIODS: MockMbrFixture['periods'] = [
  { periodId: 21, optionCounts: BALLOT, members: 1_240, childSpendable: 3_000_000n },
  { periodId: 22, optionCounts: [4, 4, 4], members: 880, childSpendable: 0n },
]

const POOLS: NonNullable<MockMbrFixture['frac']>['pools'] = [
  { instanceNumId: 1, name: 'Folks Finance xALGO', members: 1_204, perVoter: 113_300n, childSpendable: 1_000_000n },
  { instanceNumId: 2, name: 'Tinyman tALGO', members: 806, perVoter: 113_300n, childSpendable: 0n },
  { instanceNumId: 3, name: 'Réti pool #42', members: 312, perVoter: 113_300n, childSpendable: 0n },
]

function fixture(overrides: Partial<MockMbrFixture> = {}): MockMbrFixture {
  return {
    periods: COUNTED_PERIODS,
    // 1_700 gGov accounts have yet to delegate, plus 940 AQ holders the gGov registry has never
    // seen but must still be able to pay for — the two delegation cards.
    undelegated: { ggov: 1_700, pooled: 940 },
    mbrTopUp: GGOV_MBR_TOPUP,
    ggovBalance: { amount: 400_000_000n, minBalance: 12_000_000n },
    frac: {
      pools: POOLS,
      mbrTopUp: FRAC_MBR_TOPUP,
      balance: { amount: 300_000_000n, minBalance: 8_000_000n },
    },
    ...overrides,
  }
}

const meta: Meta<typeof RegistryFundingPanel> = {
  title: 'MANAGE/RegistryFundingPanel',
  component: RegistryFundingPanel,
  decorators: [
    (Story, ctx) => {
      setMockMbrFixture((ctx.parameters.mbr as MockMbrFixture) ?? null)
      return (
        <div className="mx-auto w-full max-w-[1232px] p-6">
          <Story />
        </div>
      )
    },
  ],
}
export default meta
type Story = StoryObj<typeof RegistryFundingPanel>

/** Both registries hold more than they owe — the steady state an operator wants to see. */
export const Covered: Story = {
  name: 'Both registries covered',
  parameters: { mbr: fixture() },
}

/**
 * The gGov registry cannot cover a full turnout plus the outstanding delegations, so the top-up
 * button carries the exact figure. The frac side is still fine, which is the point of two columns.
 */
export const GgovShort: Story = {
  name: 'gGov registry short',
  parameters: { mbr: fixture({ ggovBalance: { amount: 14_000_000n, minBalance: 12_000_000n } }) },
}

/** Both short — every warning path at once. */
export const BothShort: Story = {
  name: 'Both registries short',
  parameters: {
    mbr: fixture({
      ggovBalance: { amount: 14_000_000n, minBalance: 12_000_000n },
      frac: {
        pools: POOLS,
        mbrTopUp: FRAC_MBR_TOPUP,
        balance: { amount: 8_500_000n, minBalance: 8_000_000n },
      },
    }),
  },
}

/** A network with no frac deployment: one column, no pooled row, nothing lazily imported. */
export const NoFracRegistry: Story = {
  name: 'No fractional registry',
  parameters: { mbr: fixture({ frac: undefined }) },
}

/**
 * No ready periods: the voting term is empty and the requirement is the two delegation obligations
 * alone — which never go away while accounts on either registry have not delegated.
 */
export const DelegationOnly: Story = {
  name: 'No ready periods — delegation only',
  parameters: {
    mbr: fixture({
      periods: [],
      frac: { pools: [], mbrTopUp: FRAC_MBR_TOPUP, balance: { amount: 300_000_000n, minBalance: 8_000_000n } },
    }),
  },
}

/** First paint, before any balance has resolved. */
export const Loading: Story = {
  name: 'Loading',
  parameters: { mbr: fixture({ isLoading: true }) },
}
