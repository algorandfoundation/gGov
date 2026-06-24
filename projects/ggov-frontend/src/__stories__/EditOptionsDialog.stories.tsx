import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from 'storybook/test'
import { EditOptionsDialog } from '@/components/pages/manage/EditOptionsDialog'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

/**
 * §4.1 — the edit-topic-options dialog (admin/manage). Reorderable option rows
 * (up/down + remove), inline validation (no blanks, no duplicates, ≥2 options),
 * and a phase-aware Save button. The on-chain mutation is mocked here, so Save
 * runs the fake signing→saving→saved flow without touching the chain.
 */
const meta: Meta<typeof EditOptionsDialog> = {
  title: 'MISC_DIALOGS/4.1 Edit options dialog',
  component: EditOptionsDialog,
  // Connected wallet so the Save button's signing label reads "Sign in Lute…".
  parameters: { wallet: { walletName: 'Lute', accounts: demoAccounts.slice(0, 1) } },
  args: { periodId: 1, topicIndex: 0, onClose: () => {} },
}
export default meta
type Story = StoryObj<typeof EditOptionsDialog>

export const Default: Story = {
  args: { initialOptions: ['Increase rewards', 'Keep rewards flat', 'Decrease rewards'] },
}

export const MinimumOptions: Story = {
  name: 'Two options (remove disabled)',
  args: { initialOptions: ['Yes', 'No'] },
}

export const ValidationError: Story = {
  name: 'Validation — duplicate option',
  args: { initialOptions: ['Alice', 'Bob', 'Carol'] },
  play: async ({ canvasElement: _canvasElement }) => {
    // Type a duplicate into the third option to surface the inline error.
    const canvas = within(document.body)
    const third = canvas.getByLabelText('Option 3') as HTMLInputElement
    await userEvent.clear(third)
    await userEvent.type(third, 'Alice')
  },
}
