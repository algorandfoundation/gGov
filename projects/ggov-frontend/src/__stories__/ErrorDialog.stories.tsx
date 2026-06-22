import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from '@storybook/test'
import { ErrorDialogProvider, useErrorDialog } from '@/hooks/useErrorDialog'
import { Button } from '@/components/ui/button'

/**
 * §3 — the transaction / error dialog. Raised by `showError(err)` for any failure
 * that isn't a user-rejection. Shows the raw error in a selectable monospace block
 * with a "Copy error" affordance.
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/3. Error dialog',
  decorators: [
    (Story) => (
      <ErrorDialogProvider>
        <Story />
      </ErrorDialogProvider>
    ),
  ],
}
export default meta
type Story = StoryObj

const SAMPLE_ERROR =
  'TransactionPool.Remember: transaction VN3…Q2A: logic eval error: assert failed pc=842. ' +
  'Details: app=1043, opcode=assert, source: voting power exceeds eligible weight for this period.'

function ErrorTrigger({ message }: { message: string }) {
  const { showError } = useErrorDialog()
  return (
    <Button variant="destructive" onClick={() => showError(new Error(message))}>
      Trigger error
    </Button>
  )
}

export const Default: Story = {
  render: () => <ErrorTrigger message={SAMPLE_ERROR} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /trigger error/i }))
  },
}

export const ShortMessage: Story = {
  render: () => <ErrorTrigger message="Insufficient balance: account needs 0.1 ALGO to cover the box MBR." />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /trigger error/i }))
  },
}
