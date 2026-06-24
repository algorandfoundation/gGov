import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent, expect } from 'storybook/test'
import VotePeriodDetail from '@/components/pages/vote/VotePeriodDetail'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import { detailScenario, emptyScenario } from '../../.storybook/mocks/scenarios'

const [alice, bob] = demoAccounts
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
    scenario: detailScenario({ phase: 'ended', eligible: true, voted: true, electSeats: 3 }),
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
