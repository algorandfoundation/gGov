import type { Meta, StoryObj } from '@storybook/react'
import Home from '@/components/pages/Home'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'
import { buildScenario, listScenario, emptyScenario, SAMPLE_TOPICS } from '../../.storybook/mocks/scenarios'

const [alice] = demoAccounts

// These are PAGE stories that pin `parameters.scenario`, so the `periodPhase`
// toolbar global is ignored here; the featured period is fixed per story. The
// `auth` global still drives the wallet unless a story pins `parameters.wallet`.
const meta: Meta<typeof Home> = {
  title: 'PAGES/1. Landing page',
  component: Home,
}
export default meta
type Story = StoryObj<typeof Home>

export const ToolbarDriven: Story = {
  name: 'Toolbar-driven (live Auth × Phase)',
  // Pins nothing — the Auth and Phase toolbar globals drive the featured period:
  // Active = an active period exists; Upcoming = no active but an upcoming one;
  // Ended = only past periods. Flip them in the toolbar without switching stories.
}

export const FeaturedActiveLoggedIn: Story = {
  name: 'Featured active — logged in',
  parameters: {
    wallet: { walletName: 'Lute', accounts: [alice] },
    scenario: listScenario({ connected: true }),
  },
}

export const FeaturedActiveLoggedOut: Story = {
  name: 'Featured active — logged out',
  parameters: {
    wallet: { connected: false },
    scenario: listScenario({ connected: false }),
  },
}

export const FeaturedUpcoming: Story = {
  name: 'Featured upcoming (countdown)',
  parameters: {
    scenario: buildScenario(
      [
        {
          id: 8,
          phase: 'upcoming',
          title: 'Period 8 · Treasury direction',
          body: 'Voting opens next week.',
          topics: SAMPLE_TOPICS,
        },
        {
          id: 7,
          phase: 'ended',
          title: 'Period 7 · Protocol upgrade',
          body: 'Closed last week.',
          topics: SAMPLE_TOPICS,
        },
      ],
      { globalLastPeriodId: 8 },
    ),
  },
}

export const FeaturedEnded: Story = {
  name: 'Featured ended (final turnout)',
  parameters: {
    scenario: buildScenario(
      [
        {
          id: 7,
          phase: 'ended',
          title: 'Period 7 · Protocol upgrade',
          body: 'This period has closed; final results are in.',
          topics: [
            { ...SAMPLE_TOPICS[0], tallies: [52_000, 21_000, 11_500] },
            { ...SAMPLE_TOPICS[1], tallies: [38_000, 30_500, 16_000] },
          ],
          committee: { totalVotes: 120_000 },
        },
      ],
      { globalLastPeriodId: 7 },
    ),
  },
}

export const SinglePeriod: Story = {
  name: 'Single period (no "Other periods")',
  parameters: {
    scenario: buildScenario(
      [
        {
          id: 9,
          phase: 'active',
          title: 'Period 9 · Reward policy',
          body: 'The only open period.',
          topics: SAMPLE_TOPICS,
        },
      ],
      { globalLastPeriodId: 9 },
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
  parameters: { scenario: emptyScenario },
}
