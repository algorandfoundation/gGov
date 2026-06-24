import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * §0.1 — the dialog primitive every modal in the app is built from. Radix-based
 * (focus-trap, Esc-to-close, scroll-lock, ARIA) with a themed navy scrim, a centered
 * panel, the header / title / description / footer slots, and an optional close ✕.
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/0. Dialog primitive',
}
export default meta
type Story = StoryObj

function DialogDemo({ withClose = true, body }: { withClose?: boolean; body?: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={withClose ? () => setOpen(false) : undefined}>
          <DialogHeader>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>A short description explaining what this dialog is for.</DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            {body ?? 'Body content goes here — forms, lists, or copy.'}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export const Default: Story = {
  render: () => <DialogDemo />,
}

export const WithoutCloseButton: Story = {
  name: 'Without close ✕',
  render: () => <DialogDemo withClose={false} />,
}

export const ScrollingBody: Story = {
  name: 'Long / scrolling body',
  render: () => (
    <DialogDemo
      body={
        <div className="space-y-3">
          {Array.from({ length: 20 }, (_, i) => (
            <p key={i}>
              Paragraph {i + 1}. The panel caps at <code>max-h-[calc(100dvh-2rem)]</code> and the inner region scrolls.
            </p>
          ))}
        </div>
      }
    />
  ),
}
