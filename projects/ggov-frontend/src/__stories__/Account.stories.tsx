import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent, expect, waitFor } from 'storybook/test'
import Account from '@/components/pages/vote/Account'
import { demoAccounts, useWallet } from '../../.storybook/mocks/use-wallet-react'
import { accountScenario, SAMPLE_POOLED } from '../../.storybook/mocks/scenarios'

const [alice, bob, carol] = demoAccounts
/** An application escrow — no NFD name, and `useAppEscrow` resolves its owning app. */
const appEscrow = 'ESCROWZ7GQ4MORSTUV2WXYZ34567ABCDEFGHIJKLMNOPQRSTUV3XKFQA'

const asAlice = { walletName: 'Lute', accounts: [alice] }
const asAliceAndBob = { walletName: 'Lute', accounts: [alice, bob] }
const loggedOut = { connected: false }

/**
 * The account page — one address's delegation, incoming delegators, voting power
 * and vote history.
 *
 * Its two faces are the axis that matters: **your own** account (the delegation
 * card is a delegate/change/remove state machine and delegator rows are
 * actionable) versus **someone else's** (everything is read-only status). Both are
 * reached from the same route, so every story pins `routeParams.address` and the
 * wallet that decides which face renders.
 */
const meta: Meta<typeof Account> = {
  title: 'PAGES/5. Account',
  component: Account,
  // The page reads the viewed address off the route — alice unless a story says otherwise.
  parameters: { routeParams: { address: alice.address } },
}
export default meta
type Story = StoryObj<typeof Account>

export const ToolbarDriven: Story = {
  name: 'Toolbar-driven (live Auth)',
  // Pins a scenario but NOT `wallet`, so the `auth` toolbar global drives the page
  // between its own-account (connected as alice) and read-only (disconnected) faces.
  parameters: {
    scenario: accountScenario({
      delegators: [bob.address],
      periods: [{ power: 12_480, voted: true }, { power: 11_920, voted: true }, { power: 9_640 }],
    }),
  },
}

// --- Your own account --------------------------------------------------------

export const OwnSelfVoting: Story = {
  name: 'Own — self-voting (delegate CTA)',
  parameters: { wallet: asAlice, scenario: accountScenario() },
}

export const OwnDelegating: Story = {
  name: 'Own — delegating (change / remove)',
  parameters: { wallet: asAlice, scenario: accountScenario({ delegatesTo: bob.address }) },
}

/** Both delegator flavours: one with a resolved NFD name, one bare address. */
export const OwnDelegatedToMe: Story = {
  name: 'Own — delegated to you (actionable rows)',
  parameters: {
    wallet: asAlice,
    scenario: accountScenario({ delegators: [bob.address, carol.address] }),
  },
}

/**
 * No committee power and no delegators, so there's nothing to delegate — the page
 * drops the delegation card entirely rather than offering a no-op action.
 */
export const OwnNoVotingPower: Story = {
  name: 'Own — no voting power (no delegation card)',
  parameters: { wallet: asAlice, scenario: accountScenario({ periods: [{ power: 0 }] }) },
}

/**
 * A pool member that produced no blocks itself. Its power sits in the pool's
 * escrows, so direct power is zero — but the internal pooled vote is still
 * delegatable, which is what keeps the delegation card on the page.
 */
export const OwnPooledOnly: Story = {
  name: 'Own — pooled power only (frac delegation)',
  parameters: {
    wallet: asAlice,
    scenario: accountScenario({
      periods: [
        { power: 0, pooled: SAMPLE_POOLED, voted: true },
        { power: 0, pooled: [SAMPLE_POOLED[0]] },
      ],
    }),
  },
}

/** A fuller vote history: a split ballot and one cast by a delegate. */
export const OwnVotesCast: Story = {
  name: 'Own — vote history',
  parameters: {
    wallet: asAlice,
    scenario: accountScenario({
      periods: [
        { power: 12_480, voted: true },
        { power: 11_920, voted: true, split: true },
        { power: 9_640, votedByDelegate: true },
        { power: 8_100 },
      ],
    }),
  },
}

export const Loading: Story = {
  name: 'Own — loading (skeletons)',
  parameters: {
    wallet: asAlice,
    scenario: accountScenario({
      delegatesTo: bob.address,
      delegators: [carol.address],
      flags: { delegationLoading: true, delegatorsLoading: true, votesLoading: true },
    }),
  },
}

// --- Someone else's account --------------------------------------------------

export const OtherSelfVoting: Story = {
  name: 'Other — read-only, votes for itself',
  parameters: {
    wallet: asAlice,
    routeParams: { address: bob.address },
    scenario: accountScenario({ account: bob.address }),
  },
}

export const OtherDelegating: Story = {
  name: 'Other — read-only, delegating with delegators',
  parameters: {
    wallet: asAlice,
    routeParams: { address: bob.address },
    scenario: accountScenario({
      account: bob.address,
      delegatesTo: alice.address,
      delegators: [carol.address],
    }),
  },
}

export const LoggedOut: Story = {
  name: 'Logged out — public profile',
  parameters: { wallet: loggedOut, scenario: accountScenario({ delegators: [bob.address] }) },
}

/**
 * An application's escrow account: the heading becomes "Application Account" and
 * the identity line carries the owning app id.
 */
export const ApplicationAccount: Story = {
  name: 'Application escrow account',
  parameters: {
    wallet: asAlice,
    routeParams: { address: appEscrow },
    scenario: accountScenario({
      account: appEscrow,
      appEscrow: 4321,
      delegatesTo: alice.address,
      periods: [{ power: 31_400 }, { power: 28_900 }],
    }),
  },
}

/** No `address` in the route — the page's own "nothing to show" branch. */
export const NoAddress: Story = {
  name: 'No address in route',
  parameters: { wallet: asAlice, routeParams: { address: '' } },
}

// --- Wallet switching --------------------------------------------------------

/**
 * Switches the wallet's active account shortly after mount, which is the only way
 * to reach the "You switched wallet accounts" banner: it fires when the account you
 * connect as moves off the account you're looking at. Needs a multi-account wallet,
 * which is the condition the page itself gates the banner on.
 */
function AccountWithLateAccountSwitch({ to }: { to: string }) {
  const { activeWallet } = useWallet()
  const switchTo = activeWallet?.setActiveAccount
  useEffect(() => {
    if (!switchTo) return
    const timer = window.setTimeout(() => switchTo(to), 600)
    return () => window.clearTimeout(timer)
  }, [switchTo, to])
  return <Account />
}

export const SwitchedWalletAccount: Story = {
  name: 'Own — wallet switched away (banner)',
  parameters: { wallet: asAliceAndBob, scenario: accountScenario({ delegators: [carol.address] }) },
  render: () => <AccountWithLateAccountSwitch to={bob.address} />,
}

// --- Interactive -------------------------------------------------------------

/**
 * Note on what these assert at the end: the scenario is a fixed fixture, so a
 * confirmed mutation doesn't move the underlying delegation the way an
 * invalidated query would in the app. What's real here is the form's own
 * lifecycle — phase-driven button labels, then the form closing on success.
 */
const formClosed = (canvas: ReturnType<typeof within>) =>
  waitFor(() => expect(canvas.queryByPlaceholderText('GOV…')).toBeNull(), { timeout: 4000 })

export const DelegateFlow: Story = {
  name: 'Own — delegate (interactive)',
  parameters: { wallet: asAlice, scenario: accountScenario() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Delegate' }))
    await userEvent.type(canvas.getByPlaceholderText('GOV…'), bob.address)
    await userEvent.click(canvas.getByRole('button', { name: 'Delegate' }))
    // The mocked mutation walks the real phase timeline: "Sign in Lute…" → sending.
    await canvas.findByText('Delegating…', undefined, { timeout: 3000 })
    await formClosed(canvas)
  },
}

export const ChangeDelegationFlow: Story = {
  name: 'Own — change delegation (interactive)',
  parameters: { wallet: asAlice, scenario: accountScenario({ delegatesTo: bob.address }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Change' }))
    // The change form keeps the current delegate visible above the new-address field.
    await expect(await canvas.findByText('Currently delegated to')).toBeInTheDocument()
    await userEvent.type(canvas.getByPlaceholderText('GOV…'), carol.address)
    await userEvent.click(canvas.getByRole('button', { name: 'Update delegation' }))
    await canvas.findByText('Updating…', undefined, { timeout: 3000 })
    await formClosed(canvas)
  },
}

export const RedelegateFlow: Story = {
  name: 'Own — forward an incoming delegation (interactive)',
  parameters: { wallet: asAlice, scenario: accountScenario({ delegators: [bob.address, carol.address] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // One row per delegator; drive the first (bob's).
    const [firstRow] = await canvas.findAllByRole('button', { name: 'Re-delegate' })
    await userEvent.click(firstRow)
    await userEvent.type(canvas.getByPlaceholderText('GOV…'), carol.address)
    await userEvent.click(canvas.getByRole('button', { name: 'Forward' }))
    await canvas.findByText('Redirecting…', undefined, { timeout: 3000 })
    await formClosed(canvas)
  },
}
