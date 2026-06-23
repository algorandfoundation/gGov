import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'

/**
 * §4.5 — branded destructive confirm, the on-system replacement for `window.confirm`:
 * orange severity icon in a tinted circle + title + body, Cancel / orange confirm.
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/4.5 Confirm dialog',
}
export default meta
type Story = StoryObj

function Demo() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Remove topic
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove topic 3?"
        description="This can't be undone. The topic and its options will be permanently deleted from this draft."
        confirmLabel="Remove topic"
        onConfirm={() => setOpen(false)}
      />
    </>
  )
}

export const Destructive: Story = {
  render: () => <Demo />,
}
