import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from 'storybook/test'
import { EditOptionsDialog } from '@/components/pages/manage/EditOptionsDialog'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

/**
 * §4.1 — the edit-topic-options dialog (admin/manage). Reorderable option rows
 * (up/down + remove), a fixed Abstain row pinned last, inline validation (no
 * blanks, no duplicates, no typed Abstain, ≥2 custom options), and a phase-aware
 * Save button. The on-chain mutation is mocked here, so Save runs the fake
 * signing→saving→saved flow without touching the chain. `initialOptions` mirrors
 * on-chain state, so stories include the trailing Abstain the dialog drops when
 * seeding and re-appends on save.
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
  args: { initialOptions: ['Increase rewards', 'Keep rewards flat', 'Decrease rewards', 'Abstain'] },
}

export const MinimumOptions: Story = {
  name: 'Two options',
  args: { initialOptions: ['Yes', 'No', 'Abstain'] },
}

export const BelowMinimum: Story = {
  name: 'Validation — too few options',
  args: { initialOptions: ['Yes', 'No', 'Abstain'] },
  play: async ({ canvasElement: _canvasElement }) => {
    // Only reachable by removing: the dialog pads its seed up to the floor.
    const canvas = within(document.body)
    await userEvent.click(canvas.getByLabelText('Remove option 2'))
  },
}

export const ValidationError: Story = {
  name: 'Validation — duplicate option',
  args: { initialOptions: ['Alice', 'Bob', 'Carol', 'Abstain'] },
  play: async ({ canvasElement: _canvasElement }) => {
    // Type a duplicate into the third option to surface the inline error.
    const canvas = within(document.body)
    const third = canvas.getByLabelText('Option 3') as HTMLInputElement
    await userEvent.clear(third)
    await userEvent.type(third, 'Alice')
  },
}
