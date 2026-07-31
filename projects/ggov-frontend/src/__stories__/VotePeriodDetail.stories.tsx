import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent, expect } from 'storybook/test'
import VotePeriodDetail from '@/components/pages/vote/VotePeriodDetail'
import { formatApprox } from '@/utils/format'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import {
  detailScenario,
  emptyScenario,
  COUNCIL_ELECTION,
  ELECTION_TOPICS,
  MULTI_ELECTIONS,
  MULTI_ELECTION_TOPICS,
  SAMPLE_POOLED,
} from '../../.storybook/mocks/scenarios'

const [alice, bob] = demoAccounts
const [xalgo, reti] = SAMPLE_POOLED
const connected = { walletName: 'Lute', accounts: [alice] }
// The detail page reads its period id from the route — every story supplies it.
const route = { periodId: '7' }

const meta: Meta<typeof VotePeriodDetail> = {
  title: 'PAGES/3. Vote detail',
  component: VotePeriodDetail,
  parameters: { routeParams: route },
}
export default meta
type Story = StoryObj<typeof VotePeriodDetail>

export const ToolbarDriven: Story = {
  name: 'Toolbar-driven (live Auth × Phase)',
  // Pins neither `scenario` nor `wallet`, so the `auth` and `periodPhase` toolbar
  // globals drive the wallet and the period state live — flip them to move between
  // upcoming/active/ended and connected/disconnected without switching stories.
  // (`routeParams` for period 7 is inherited from meta; the default scenario also
  // uses period 7, so they line up.)
}

export const ActiveEligible: Story = {
  name: 'Active — eligible, not voted',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'active', eligible: true }) },
}

export const ActiveAlreadyVoted: Story = {
  name: 'Active — already voted',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'active', eligible: true, voted: true }) },
}

export const ActiveIneligible: Story = {
  name: 'Active — ineligible (no voting power)',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'active', eligible: false }) },
}

export const ActiveLoggedOut: Story = {
  name: 'Active — logged out (connect CTA)',
  parameters: { wallet: { connected: false }, scenario: detailScenario({ phase: 'active', connected: false }) },
}

export const ActiveDelegated: Story = {
  name: 'Active — delegated accounts (one locked)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      delegators: [
        { address: bob.address, power: 2100, votedDirectly: true }, // voted directly → locked under alice
      ],
    }),
  },
}

export const Upcoming: Story = {
  name: 'Upcoming (not yet open)',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'upcoming', eligible: true }) },
}

export const EndedResults: Story = {
  name: 'Ended — results',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'ended', eligible: true, voted: true }) },
}

export const EndedElection: Story = {
  name: 'Ended — election (ranked results)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'ended',
      eligible: true,
      voted: true,
      elect: COUNCIL_ELECTION,
      topics: ELECTION_TOPICS,
    }),
  },
}

// --- Multi-election ballots --------------------------------------------------
//
// One period, one committee, one vote() — several races, told apart only by each
// candidate's `e` tag. The ballot groups by race; the payload stays flat and
// indexed by on-chain topic index.

export const ActiveMultiElection: Story = {
  name: 'Active — two elections on one ballot',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      elect: MULTI_ELECTIONS,
      topics: MULTI_ELECTION_TOPICS,
      title: 'Period 7 · Term 2 elections',
      body: 'Elect the xGov Council and the treasury committee. Each candidate is a Support / Against / Abstain ballot, ranked by net score within its own election.',
    }),
  },
}

export const EndedMultiElection: Story = {
  name: 'Ended — two elections on one ballot',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'ended',
      eligible: true,
      voted: true,
      elect: MULTI_ELECTIONS,
      topics: MULTI_ELECTION_TOPICS,
    }),
  },
}

export const ActiveMultiElectionUnassigned: Story = {
  name: 'Active — candidate in no election',
  // A candidate whose `e` tag is missing is excluded from every race, but must
  // still be votable: the contract requires every topic row to carry the voter's
  // full power, so dropping one would make the period unvotable.
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      elect: MULTI_ELECTIONS,
      topics: MULTI_ELECTION_TOPICS.map((t, i) => (i === 2 ? { ...t, e: undefined } : t)),
    }),
  },
}

export const Loading: Story = {
  parameters: {
    wallet: connected,
    scenario: { ...detailScenario({ phase: 'active', eligible: true }), flags: { periodLoading: true } },
  },
}

export const NotFound: Story = {
  name: 'Period not found',
  parameters: { wallet: connected, scenario: emptyScenario },
}

export const SwitchToAdvancedBallot: Story = {
  name: 'Active — advanced ballot (interactive)',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'active', eligible: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('tab', { name: 'Advanced' }))
    // Advanced mode swaps the radio options for per-option allocation inputs.
    await expect(await canvas.findByLabelText('Votes for Increase rewards')).toBeInTheDocument()
  },
}

export const SubmitVote: Story = {
  name: 'Active — submit vote (interactive)',
  parameters: { wallet: connected, scenario: detailScenario({ phase: 'active', eligible: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Pick one option in each of the two topics, then submit.
    await userEvent.click(await canvas.findByRole('button', { name: /Increase rewards/ }))
    await userEvent.click(await canvas.findByRole('button', { name: /Grants/ }))
    await userEvent.click(canvas.getByRole('button', { name: 'Submit vote' }))
    // The mocked mutation drives the phase timeline: signing/sending → confirmed.
    await canvas.findByText('Voting…')
    await canvas.findByText('Voted', undefined, { timeout: 4000 })
  },
}

// --- Pooled voting (fractional delegation) -----------------------------------
//
// Pooled positions are selectable rows in the same radio group as the accounts.
// The fixtures below cover each status a row can reach, plus the AlgoQuarters
// ballot a pooled selection produces.

/** One pool already voted, the other still open — the everyday two-pool case. */
export const ActivePooled: Story = {
  name: 'Active — pooled positions (one voted)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      pooled: [
        // A recorded pooled ballot is in AlgoQuarters, and totals the member's weight.
        {
          ...xalgo,
          voteRecord: [
            [xalgo.userAq, 0, 0],
            [xalgo.userAq, 0],
          ],
        },
        reti,
      ],
    }),
  },
}

/**
 * The account this pass exists for: no blocks produced, so its own row is dimmed
 * and unselectable, and its only way to vote is through its pools. The page must
 * auto-select the first eligible pooled position rather than leaving nothing chosen.
 */
export const ActivePooledOnly: Story = {
  name: 'Active — pooled only (no direct power)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({ phase: 'active', eligible: false, pooled: SAMPLE_POOLED }),
  },
}

/** The pool hasn't snapshotted the period (or is mid-ingest) — not the member's fault. */
export const ActivePoolNotReady: Story = {
  name: 'Active — pool not ready',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      pooled: [{ ...xalgo, canVote: false, poolNotReady: true }, reti],
    }),
  },
}

/** The design's level-2 row: a pool belonging to an account that delegated to you. */
export const ActivePooledViaDelegator: Story = {
  name: 'Active — delegator’s pool (nested two levels)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      pooled: [xalgo],
      delegators: [{ address: bob.address, power: 2100, pooled: [reti] }],
    }),
  },
}

/** A delegator cast its own pooled ballot, so the delegatee can't override it. */
export const ActivePooledLocked: Story = {
  name: 'Active — delegator’s pool locked (voted directly)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({
      phase: 'active',
      eligible: true,
      delegators: [
        {
          address: bob.address,
          power: 2100,
          pooled: [
            {
              ...reti,
              canVote: false,
              votedDirectly: true,
              voteRecord: [
                [reti.userAq, 0, 0],
                [0, reti.userAq],
              ],
            },
          ],
        },
      ],
    }),
  },
}

/** Selecting a pooled row keeps simple mode in votes and only advanced mode in AQ. */
export const PooledBallotUnits: Story = {
  name: 'Active — pooled ballot units (interactive)',
  parameters: {
    wallet: connected,
    scenario: detailScenario({ phase: 'active', eligible: true, pooled: SAMPLE_POOLED }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('radio', { name: /Folks Finance xALGO/ }))
    // Simple mode labels the weight in approximate votes — AlgoQuarters stay out of it.
    await userEvent.click(await canvas.findByRole('button', { name: /Increase rewards/ }))
    await expect(await canvas.findByText(`All ≈ ${formatApprox(xalgo.votes)} votes`)).toBeInTheDocument()
    await expect(canvas.queryByText(`All ${xalgo.userAq.toLocaleString()} AQ`)).not.toBeInTheDocument()
    // Advanced mode is where the unit surfaces: per-option AQ inputs, plus the
    // link out to what AlgoQuarters are.
    await userEvent.click(await canvas.findByRole('tab', { name: 'Advanced' }))
    await expect(await canvas.findByLabelText('AQ for Increase rewards')).toBeInTheDocument()
    await expect(await canvas.findByRole('link', { name: 'How pooled voting works' })).toBeInTheDocument()
  },
}

/** Membership known, amounts not in yet — no pooled rows, no flicker. */
export const PooledPending: Story = {
  name: 'Active — pooled amounts loading',
  parameters: {
    wallet: connected,
    scenario: {
      ...detailScenario({ phase: 'active', eligible: true, pooled: SAMPLE_POOLED }),
      flags: { pooledLoading: true },
    },
  },
}
