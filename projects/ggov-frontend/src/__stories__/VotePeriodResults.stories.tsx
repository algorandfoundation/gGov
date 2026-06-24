import type { Meta, StoryObj } from '@storybook/react'
import VotePeriodResults from '@/components/pages/vote/VotePeriodResults'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import {
  buildScenario,
  emptyScenario,
  SAMPLE_TOPICS_TALLIED,
  ELECTION_TOPICS,
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
        electSeats: election ? 3 : undefined,
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
