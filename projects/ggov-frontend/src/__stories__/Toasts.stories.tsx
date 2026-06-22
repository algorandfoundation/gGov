import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from '@storybook/test'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/**
 * §2 — notification toasts (sonner). The app mounts a single `<Toaster>` (also
 * mounted globally in this Storybook's preview) and spans five shapes: success,
 * error, neutral, success-with-action, and a persistent/updating loading toast.
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/2. Toasts',
}
export default meta
type Story = StoryObj

let counter = 0

function ToastButtons() {
  return (
    <div className="grid max-w-xs grid-cols-1 gap-2">
      <Button variant="outline" onClick={() => toast.success('Address copied')}>
        success
      </Button>
      <Button variant="outline" onClick={() => toast.error("Couldn't copy address")}>
        error
      </Button>
      <Button variant="outline" onClick={() => toast('Signing cancelled')}>
        neutral
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.success('Vote submitted', {
            action: { label: 'Copy Txn ID', onClick: () => toast('Txn ID copied') },
          })
        }
      >
        success + action
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const id = `signing-${counter++}`
          toast.loading('Signing 1/2 — Creating period', { id, duration: Infinity })
          setTimeout(() => toast.loading('Signing 2/2 — Uploading period body', { id, duration: Infinity }), 1200)
          setTimeout(() => toast.success('Period created', { id, duration: 4000 }), 2400)
        }}
      >
        persistent / updating loading
      </Button>
    </div>
  )
}

export const Gallery: Story = {
  render: () => <ToastButtons />,
}

export const SuccessWithAction: Story = {
  name: 'Success + action (shown)',
  render: () => <ToastButtons />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /success \+ action/i }))
  },
}
