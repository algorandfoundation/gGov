import type { Meta, StoryObj } from '@storybook/react'
import Pools from '@/components/pages/vote/Pools'
import { buildScenario, SAMPLE_TOPICS, alice, bob, carol, makeCommitteeId } from '../../.storybook/mocks/scenarios'
import { toBase64Url } from '../../.storybook/mocks/queries'
import type { MockPooledPosition } from '../../.storybook/mocks/scenarios'

/**
 * `/pools/$committeeId` — every staking pool holding voting power in one
 * committee, ranked, over the composition bar that says how much of the
 * committee is pooled at all.
 *
 * The stories exercise the three things that resolve independently on this page:
 * the pool set (frac registry), the AlgoQuarters ledger behind each pool's power,
 * and per-pool turnout — plus the two filters (`Liquid` / `Réti`) and the "yours"
 * marker the connected wallet drives.
 */
const PERIOD_ID = 19
const COMMITTEE_ID = makeCommitteeId(PERIOD_ID)
const COMMITTEE_B64 = toBase64Url(COMMITTEE_ID)
const COMMITTEE_TOTAL_VOTES = 3_000_000

/**
 * One pool as the fixture sees it. `share` is this account's slice; the pool-wide
 * figures (`poolVotes`, `totalAq`, `poolMembers`, `poolVotedAq`) are what the
 * index actually renders.
 */
function pool(opts: {
  id: number
  name: string
  aq: number
  votes: number
  members: number
  votedPct: number
  userAq?: number
}): MockPooledPosition {
  const userAq = opts.userAq ?? 0
  return {
    instanceNumId: opts.id,
    instanceName: opts.name,
    userAq,
    totalAq: opts.aq,
    sharePct: (userAq / opts.aq) * 100,
    poolVotes: opts.votes,
    votes: (userAq / opts.aq) * opts.votes,
    poolMembers: opts.members,
    poolVotedAq: Math.round((opts.votedPct / 100) * opts.aq),
  }
}

/** Two liquid-staking tokens and two Réti pools — enough to exercise the filter. */
const XALGO = pool({ id: 1, name: 'Folks Finance xALGO', aq: 512_400, votes: 518_240, members: 1_204, votedPct: 64 })
const TALGO = pool({ id: 2, name: 'Tinyman tALGO', aq: 268_900, votes: 271_410, members: 806, votedPct: 51 })
const RETI42 = pool({ id: 3, name: 'Réti pool #42', aq: 90_570, votes: 92_180, members: 312, votedPct: 47 })
const CALGO = pool({ id: 4, name: 'CompX cALGO', aq: 70_780, votes: 69_940, members: 241, votedPct: 44 })
const RETI17 = pool({ id: 5, name: 'Réti pool #17', aq: 61_240, votes: 62_530, members: 188, votedPct: 38 })
const RETI08 = pool({ id: 6, name: 'Réti pool #08', aq: 44_110, votes: 43_760, members: 96, votedPct: 29 })

const ALL_POOLS = [XALGO, TALGO, RETI42, CALGO, RETI17, RETI08]

/** The same pool set, but held by the connected account (drives the "yours" pill). */
const withStake = (positions: MockPooledPosition[], userAq: number) =>
  positions.map((p) => ({
    ...p,
    userAq,
    sharePct: (userAq / p.totalAq) * 100,
    votes: (userAq / p.totalAq) * p.poolVotes,
  }))

function poolsScenario(
  accounts: Record<string, MockPooledPosition[]>,
  opts: { flags?: { pooledLoading?: boolean }; period?: boolean } = {},
) {
  return buildScenario(
    [
      {
        id: PERIOD_ID,
        phase: opts.period === false ? 'upcoming' : 'ended',
        topics: SAMPLE_TOPICS,
        committeeId: COMMITTEE_ID,
        committee: { periodStart: 48_200_000, periodEnd: 51_200_000, totalVotes: COMMITTEE_TOTAL_VOTES },
        accounts: Object.fromEntries(
          Object.entries(accounts).map(([address, pooled]) => [address, { power: 0, pooled }]),
        ),
      },
      {
        id: 18,
        phase: 'ended',
        topics: SAMPLE_TOPICS,
        committee: { periodStart: 45_000_000, periodEnd: 48_000_000, totalVotes: 2_900_000 },
      },
      {
        id: 17,
        phase: 'ended',
        topics: SAMPLE_TOPICS,
        committee: { periodStart: 42_000_000, periodEnd: 45_000_000, totalVotes: 2_780_000 },
      },
    ],
    { globalLastPeriodId: PERIOD_ID, flags: opts.flags },
  )
}

const meta: Meta<typeof Pools> = {
  title: 'PAGES/Pools',
  component: Pools,
  parameters: { layout: 'fullscreen', routeParams: { committeeId: COMMITTEE_B64 } },
  decorators: [
    (Story) => (
      <div className="w-full p-6">
        <Story />
      </div>
    ),
  ],
}
export default meta
type Story = StoryObj<typeof Pools>

export const Composition: Story = {
  name: 'Six pools — composition, ranking, turnout',
  parameters: { scenario: poolsScenario({ [alice.address]: ALL_POOLS }) },
}

/** The connected account is in two of the pools, so those rows carry "yours". */
export const WithYourPools: Story = {
  name: 'Connected — two pools marked "yours"',
  parameters: {
    scenario: poolsScenario({
      [alice.address]: [...withStake([XALGO, RETI42], 4_120), TALGO, CALGO, RETI17, RETI08],
    }),
  },
}

/** A committee whose pools are all liquid-staking tokens: no filter is offered. */
export const LiquidOnly: Story = {
  name: 'Liquid only — filter suppressed',
  parameters: { scenario: poolsScenario({ [alice.address]: [XALGO, TALGO, CALGO] }) },
}

/** Several accounts, so the fixture spreads positions the way the registry would. */
export const ManyAccounts: Story = {
  name: 'Positions spread across accounts',
  parameters: {
    scenario: poolsScenario({
      [alice.address]: withStake([XALGO, TALGO], 4_120),
      [bob.address]: withStake([RETI42], 1_730),
      [carol.address]: [CALGO, RETI17, RETI08],
    }),
  },
}

export const Loading: Story = {
  name: 'Pool set still resolving',
  parameters: { scenario: poolsScenario({ [alice.address]: ALL_POOLS }, { flags: { pooledLoading: true } }) },
}

export const NoPools: Story = {
  name: 'Empty — no pool has synced this committee',
  parameters: { scenario: poolsScenario({}) },
}
