import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent, expect } from 'storybook/test'
import VotePeriods from '@/components/pages/vote/VotePeriods'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import { buildScenario, listScenario, emptyScenario, SAMPLE_TOPICS } from '../../.storybook/mocks/scenarios'

const [alice] = demoAccounts

// PAGE stories pin `parameters.scenario`, so the `periodPhase` global is ignored;
// the list spans every phase. The `auth` global drives the sidebar wallet state
// unless a story pins `parameters.wallet`.
const meta: Meta<typeof VotePeriods> = {
  title: 'PAGES/2. Vote index',
  component: VotePeriods,
}
export default meta
type Story = StoryObj<typeof VotePeriods>

export const ToolbarDriven: Story = {
  name: 'Toolbar-driven (live Auth × Phase)',
  // Pins nothing — the Auth and Phase toolbar globals drive the list: Active = an
  // active period exists (drives the hero); Upcoming = no active but an upcoming
  // one; Ended = only past periods. Flip them in the toolbar.
}

export const MixedListLoggedIn: Story = {
  name: 'Mixed list — logged in',
  parameters: {
    wallet: { walletName: 'Lute', accounts: [alice] },
    scenario: listScenario({ connected: true }),
  },
}

export const MixedListLoggedOut: Story = {
  name: 'Mixed list — logged out',
  parameters: {
    wallet: { connected: false },
    scenario: listScenario({ connected: false }),
  },
}

export const NoActivePeriod: Story = {
  name: 'No active period',
  parameters: {
    wallet: { connected: false },
    scenario: buildScenario(
      [
        { id: 8, phase: 'upcoming', title: 'Period 8 · Treasury direction', body: 'Opens soon.', topics: SAMPLE_TOPICS },
        { id: 7, phase: 'ended', title: 'Period 7 · Protocol upgrade', body: 'Closed last week.', topics: SAMPLE_TOPICS },
      ],
      { globalLastPeriodId: 8 },
    ),
  },
}

export const Loading: Story = {
  parameters: {
    scenario: buildScenario([{ id: 9, phase: 'active', topics: SAMPLE_TOPICS }], { flags: { periodsLoading: true } }),
  },
}

export const Empty: Story = {
  name: 'Empty (no periods)',
  parameters: { wallet: { connected: false }, scenario: emptyScenario },
}

export const FilterToClosed: Story = {
  name: 'Filter → Closed tab',
  parameters: {
    wallet: { connected: false },
    scenario: listScenario({ connected: false }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The upcoming period only appears in the filtered list (not the active hero).
    await expect(canvas.queryAllByText('Period 8 · Treasury direction').length).toBeGreaterThan(0)
    await userEvent.click(canvas.getByRole('tab', { name: 'Closed' }))
    await expect(canvas.queryAllByText('Period 8 · Treasury direction')).toHaveLength(0)
    // An ended period remains.
    await expect(canvas.queryAllByText('Period 7 · Protocol upgrade').length).toBeGreaterThan(0)
  },
}
