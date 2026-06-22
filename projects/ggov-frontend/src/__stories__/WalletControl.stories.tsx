import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from '@storybook/test'
import TopBarAccount from '@/components/TopBarAccount'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

/**
 * §1 — the connect-wallet control. Logged out it's a "Connect wallet" button that
 * opens the wallet-picker dialog (a list of `outline` buttons, one per wallet).
 * Logged in it becomes the account dropdown (see §6 — User account dropdown).
 */
const meta: Meta<typeof TopBarAccount> = {
  title: 'MISC_DIALOGS/1. Connect wallet',
  component: TopBarAccount,
}
export default meta
type Story = StoryObj<typeof TopBarAccount>

export const Disconnected: Story = {
  parameters: { wallet: { connected: false } },
}

export const WalletPicker: Story = {
  name: 'Wallet picker (dialog open)',
  parameters: { wallet: { connected: false } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /connect wallet/i }))
  },
}

export const ConnectedSingleAccount: Story = {
  name: 'Connected — single account',
  parameters: { wallet: { walletName: 'Pera', accounts: demoAccounts.slice(0, 1) } },
}

export const ConnectedMultiAccount: Story = {
  name: 'Connected — multiple accounts',
  parameters: { wallet: { walletName: 'Lute', accounts: demoAccounts } },
}
