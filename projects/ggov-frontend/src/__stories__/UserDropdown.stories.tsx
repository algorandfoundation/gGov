import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from '@storybook/test'
import UserDropdown from '@/components/UserDropdown'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

/**
 * §6 — the user account dropdown (Radix DropdownMenu). The avatar pill opens an
 * identity header (with the Wallet-icon decoration), an account switcher shown
 * only when the wallet exposes >1 account, a "Go to my account" link, and a
 * destructive Disconnect. Switcher rows read "<ABCDEF.. / nfd.algo> <account name>".
 */
const meta: Meta<typeof UserDropdown> = {
  title: 'MISC_DIALOGS/6. User account dropdown',
  component: UserDropdown,
  parameters: { wallet: { walletName: 'Lute', accounts: demoAccounts } },
}
export default meta
type Story = StoryObj<typeof UserDropdown>

const openMenu = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: /open account menu/i }))
}

export const ClosedTrigger: Story = {
  name: 'Trigger (closed)',
}

export const OpenMultiAccount: Story = {
  name: 'Open — multiple accounts (switcher)',
  play: openMenu,
}

export const OpenSingleAccount: Story = {
  name: 'Open — single account (no switcher)',
  parameters: { wallet: { walletName: 'Pera', accounts: demoAccounts.slice(0, 1) } },
  play: openMenu,
}

export const Mobile: Story = {
  name: 'Open — mobile trigger (avatar only)',
  render: () => <UserDropdown small />,
  play: openMenu,
}
