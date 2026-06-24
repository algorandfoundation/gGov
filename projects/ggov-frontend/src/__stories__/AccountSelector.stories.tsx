import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { within, userEvent, expect } from 'storybook/test'
import AccountSelector, { type AccountSelectorItem } from '@/components/AccountSelector'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

const [alice, bob, carol] = demoAccounts
// A fourth address (no NFD name) to exercise the raw-address identity row.
const dave = 'DAVE2OY664QMPQ4MORSTUV2WXYZ34567ABCDEFGHIJKLMNOPQR4RAGQ'

/** Stateful wrapper so the radio selection actually moves on click / arrow keys. */
function Selectable({
  accounts,
  initial = null,
  connectedCount,
  delegatedCount,
}: {
  accounts: AccountSelectorItem[]
  initial?: string | null
  connectedCount?: number
  delegatedCount?: number
}) {
  const [selected, setSelected] = useState<string | null>(initial)
  return (
    <div className="w-full max-w-[560px]">
      <AccountSelector
        accounts={accounts}
        selected={selected}
        onSelect={setSelected}
        connectedCount={connectedCount}
        delegatedCount={delegatedCount}
      />
    </div>
  )
}

const meta: Meta<typeof AccountSelector> = {
  title: 'COMPONENTS/Account selector',
  component: AccountSelector,
  // Pure presentational component — no wallet/SDK needed, only the NFD name mock.
}
export default meta
type Story = StoryObj<typeof AccountSelector>

export const SingleEligible: Story = {
  name: 'Single eligible account',
  render: () => (
    <Selectable
      connectedCount={1}
      initial={alice.address}
      accounts={[{ address: alice.address, votingPower: 4200n, canVote: true, hasVoted: false }]}
    />
  ),
}

export const MixedStatuses: Story = {
  name: 'Mixed statuses (eligible · voted · ineligible · loading)',
  render: () => (
    <Selectable
      connectedCount={4}
      initial={alice.address}
      accounts={[
        { address: alice.address, votingPower: 4200n, canVote: true, hasVoted: false },
        { address: bob.address, votingPower: 2100n, canVote: true, hasVoted: true },
        // Has standing but can't vote → shown dimmed (kept because power > 0).
        { address: carol.address, votingPower: 800n, canVote: false },
        // canVote undefined → "Checking…".
        { address: dave, votingPower: undefined, canVote: undefined },
      ]}
    />
  ),
}

export const DelegatedChildren: Story = {
  name: 'Delegated accounts (nested · one locked)',
  render: () => (
    <Selectable
      connectedCount={1}
      delegatedCount={2}
      initial={alice.address}
      accounts={[
        {
          address: alice.address,
          votingPower: 4200n,
          canVote: true,
          hasVoted: false,
          delegated: [
            { address: bob.address, votingPower: 2100n, canVote: true, hasVoted: false },
            // Voted directly → the delegate can't override it (locked).
            { address: carol.address, votingPower: 1500n, canVote: false, hasVoted: true, votedDirectly: true },
          ],
        },
      ]}
    />
  ),
}

export const AllVoted: Story = {
  name: 'All accounts voted',
  render: () => (
    <Selectable
      connectedCount={3}
      accounts={demoAccounts.map((a) => ({ address: a.address, votingPower: 1800n, canVote: true, hasVoted: true }))}
    />
  ),
}

export const Loading: Story = {
  name: 'Loading (eligibility unresolved)',
  render: () => (
    <Selectable
      connectedCount={3}
      accounts={demoAccounts.map((a) => ({ address: a.address, votingPower: undefined, canVote: undefined }))}
    />
  ),
}

export const Empty: Story = {
  name: 'Empty (no voting power)',
  render: () => (
    <Selectable
      connectedCount={2}
      accounts={[
        { address: alice.address, votingPower: 0n, canVote: false },
        { address: bob.address, votingPower: 0n, canVote: false },
      ]}
    />
  ),
}

export const ResolvedNfdName: Story = {
  name: 'Resolved NFD name (two-line identity)',
  // alice/bob carry an `.algo` name in the NFD mock, so the name sits over the address.
  render: () => (
    <Selectable
      connectedCount={2}
      initial={alice.address}
      accounts={[
        { address: alice.address, votingPower: 4200n, canVote: true },
        { address: bob.address, votingPower: 2100n, canVote: true },
      ]}
    />
  ),
}

export const KeyboardNavigation: Story = {
  name: 'Keyboard navigation (arrow keys)',
  render: () => (
    <Selectable
      connectedCount={3}
      accounts={[
        { address: alice.address, votingPower: 4200n, canVote: true },
        { address: bob.address, votingPower: 2100n, canVote: true, hasVoted: true },
        { address: carol.address, votingPower: 1500n, canVote: true },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const radios = canvas.getAllByRole('radio')
    radios[0].focus()
    // End jumps to the last selectable row; Home returns to the first.
    await userEvent.keyboard('{End}')
    await expect(radios[radios.length - 1]).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    await expect(radios[0]).toHaveAttribute('aria-checked', 'true')
  },
}
