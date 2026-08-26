import type { Meta, StoryObj } from '@storybook/react'
import VotingPowerByCommittee from '@/components/vote/VotingPowerByCommittee'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import { buildScenario, SAMPLE_TOPICS, SAMPLE_POOLED } from '../../.storybook/mocks/scenarios'

const [alice] = demoAccounts

/**
 * The Account page's "Voting power by committee" card — direct block production
 * plus any pooled (fractional-delegation) share, merged into one panel.
 *
 * The story that matters most is `DirectOnly`: it must be indistinguishable from
 * the pre-pooled card, because that is what every account on a network without a
 * frac registry sees.
 */
const meta: Meta<typeof VotingPowerByCommittee> = {
  title: 'COMPONENTS/Voting power by committee',
  component: VotingPowerByCommittee,
  args: { account: alice.address },
  decorators: [
    (Story) => (
      <div className="max-w-[520px] p-4">
        <Story />
      </div>
    ),
  ],
}
export default meta
type Story = StoryObj<typeof VotingPowerByCommittee>

/** Three committees of direct power, two pools in the newest two. */
const pooledScenario = (opts: { pooledLoading?: boolean } = {}) =>
  buildScenario(
    [
      {
        id: 9,
        phase: 'active',
        topics: SAMPLE_TOPICS,
        committee: { periodStart: 48_200_000, periodEnd: 51_200_000 },
        accounts: { [alice.address]: { power: 12_480, pooled: SAMPLE_POOLED } },
      },
      {
        id: 8,
        phase: 'ended',
        topics: SAMPLE_TOPICS,
        committee: { periodStart: 45_000_000, periodEnd: 48_000_000 },
        accounts: { [alice.address]: { power: 11_920, pooled: [SAMPLE_POOLED[0]] } },
      },
      {
        id: 7,
        phase: 'ended',
        topics: SAMPLE_TOPICS,
        committee: { periodStart: 42_000_000, periodEnd: 45_000_000 },
        accounts: { [alice.address]: { power: 9_640 } },
      },
    ],
    { globalLastPeriodId: 9, flags: opts.pooledLoading ? { pooledLoading: true } : undefined },
  )

export const Pooled: Story = {
  name: 'Pooled — direct + per-pool breakdown',
  parameters: { scenario: pooledScenario() },
}

export const PooledPending: Story = {
  name: 'Pooled — member, amounts still resolving',
  parameters: { scenario: pooledScenario({ pooledLoading: true }) },
}

export const DirectOnly: Story = {
  name: 'Direct only — no pooled positions (degradation)',
  parameters: {
    scenario: buildScenario(
      [
        {
          id: 9,
          phase: 'active',
          topics: SAMPLE_TOPICS,
          committee: { periodStart: 48_200_000, periodEnd: 51_200_000 },
          accounts: { [alice.address]: { power: 12_480 } },
        },
        {
          id: 8,
          phase: 'ended',
          topics: SAMPLE_TOPICS,
          committee: { periodStart: 45_000_000, periodEnd: 48_000_000 },
          accounts: { [alice.address]: { power: 11_920 } },
        },
      ],
      { globalLastPeriodId: 9 },
    ),
  },
}

/** Power held entirely through a pool — no blocks produced by the account itself. */
export const PooledOnly: Story = {
  name: 'Pooled only — no blocks produced',
  parameters: {
    scenario: buildScenario(
      [
        {
          id: 9,
          phase: 'active',
          topics: SAMPLE_TOPICS,
          committee: { periodStart: 48_200_000, periodEnd: 51_200_000 },
          accounts: { [alice.address]: { power: 0, pooled: SAMPLE_POOLED } },
        },
      ],
      { globalLastPeriodId: 9 },
    ),
  },
}

export const NoCommittees: Story = {
  name: 'Empty — no committees',
  parameters: {
    scenario: buildScenario([{ id: 9, phase: 'active', topics: SAMPLE_TOPICS }], { globalLastPeriodId: 9 }),
  },
}
