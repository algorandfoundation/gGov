import type { Meta, StoryObj } from '@storybook/react'
import VotePeriodResults from '@/components/pages/vote/VotePeriodResults'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import {
  buildScenario,
  emptyScenario,
  SAMPLE_TOPICS_TALLIED,
  ELECTION_TOPICS,
  COUNCIL_ELECTION,
  MULTI_ELECTIONS,
  MULTI_ELECTION_TOPICS,
  type Phase,
} from '../../.storybook/mocks/scenarios'

const [alice] = demoAccounts
const connected = { walletName: 'Lute', accounts: [alice] }
// The results page reads its period id from the route — supplied for every story.
const route = { periodId: '7' }

/** Single-period results scenario. Standard → per-topic tallies; election → ranked candidates. */
function resultsScenario(phase: Phase, election: boolean) {
  // Single-choice record so the standard results show the "YOUR VOTE" tag.
  const standardRecord = [
    [4200, 0, 0],
    [0, 4200, 0],
  ]
  return buildScenario(
    [
      {
        id: 7,
        phase,
        title: election ? 'Period 7 · Council election' : 'Period 7 · Protocol upgrade',
        body: election
          ? 'Elect the next governance council — the top 3 candidates are seated.'
          : 'A standard protocol-upgrade vote.',
        elect: election ? COUNCIL_ELECTION : undefined,
        topics: election ? ELECTION_TOPICS : SAMPLE_TOPICS_TALLIED,
        committee: { totalVotes: 84_500 },
        voters: [alice.address],
        accounts: { [alice.address]: { power: 4200, voteRecord: election ? undefined : standardRecord } },
      },
    ],
    { globalLastPeriodId: 7 },
  )
}

const meta: Meta<typeof VotePeriodResults> = {
  title: 'PAGES/4. Vote results',
  component: VotePeriodResults,
  parameters: { routeParams: route },
}
export default meta
type Story = StoryObj<typeof VotePeriodResults>

export const ToolbarDriven: Story = {
  name: 'Toolbar-driven (live Auth × Phase × Period type)',
  // Pins nothing — the toolbar globals drive it. Results only render for an ended
  // period (standard) or an active/ended election (shown live); otherwise the page
  // shows "results aren't available yet". So: Phase=Ended → standard tallies;
  // Period type=Election → ranked candidates (live when Phase=Active).
}

export const StandardResults: Story = {
  name: 'Standard — final tallies',
  parameters: { wallet: connected, scenario: resultsScenario('ended', false) },
}

export const ElectionFinal: Story = {
  name: 'Election — final ranked results',
  parameters: { wallet: connected, scenario: resultsScenario('ended', true) },
}

export const ElectionLive: Story = {
  name: 'Election — live results (active)',
  parameters: { wallet: connected, scenario: resultsScenario('active', true) },
}

/**
 * One shared ballot carrying two independent elections: candidates are bucketed by their
 * `e` tag and each election is ranked against its own seat count.
 */
export const MultiElection: Story = {
  name: 'Election — two elections on one ballot',
  parameters: {
    wallet: connected,
    scenario: buildScenario(
      [
        {
          id: 7,
          phase: 'ended',
          title: 'Period 7 · Council + treasury elections',
          body: 'Two seats being filled on one ballot: the governance council (3 seats) and the treasury committee (2 seats). Each is ranked separately.',
          elect: MULTI_ELECTIONS,
          topics: MULTI_ELECTION_TOPICS,
          committee: { totalVotes: 84_500 },
          voters: [alice.address],
          accounts: { [alice.address]: { power: 4200 } },
        },
      ],
      { globalLastPeriodId: 7 },
    ),
  },
}

/**
 * An election period with a candidate whose `e` tag is missing — it ranks in no election,
 * so the page reports it instead of quietly folding it into the first race.
 */
export const MultiElectionUnassigned: Story = {
  name: 'Election — unassigned candidate',
  parameters: {
    wallet: connected,
    scenario: buildScenario(
      [
        {
          id: 7,
          phase: 'ended',
          title: 'Period 7 · Council + treasury elections',
          body: 'One candidate was never assigned to an election.',
          elect: MULTI_ELECTIONS,
          topics: MULTI_ELECTION_TOPICS.map((t, i) => (i === 2 ? { ...t, e: undefined } : t)),
          committee: { totalVotes: 84_500 },
          voters: [alice.address],
          accounts: { [alice.address]: { power: 4200 } },
        },
      ],
      { globalLastPeriodId: 7 },
    ),
  },
}

export const NotAvailableYet: Story = {
  name: 'Not available yet (standard, still open)',
  parameters: { wallet: connected, scenario: resultsScenario('active', false) },
}

export const Loading: Story = {
  parameters: {
    wallet: connected,
    scenario: { ...resultsScenario('ended', false), flags: { periodLoading: true } },
  },
}

export const NotFound: Story = {
  name: 'Period not found',
  parameters: { wallet: connected, scenario: emptyScenario },
}
