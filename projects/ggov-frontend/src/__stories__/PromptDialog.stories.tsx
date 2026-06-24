import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { PromptDialog } from '@/components/ui/prompt-dialog'
import { Button } from '@/components/ui/button'

/**
 * §4.5 — branded single-field prompt, the on-system replacement for `window.prompt`
 * (the markdown editor's link URL): labeled input with a leading icon, Cancel / Add link.
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/4.5 Prompt dialog',
}
export default meta
type Story = StoryObj

function Demo() {
  const [open, setOpen] = useState(true)
  const [url, setUrl] = useState('')
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Add link
      </Button>
      {url && <p className="mt-3 font-mono text-xs text-muted-foreground">submitted: {url}</p>}
      <PromptDialog
        open={open}
        onOpenChange={setOpen}
        title="Add link"
        description="Paste the URL this text should link to."
        label="Link URL"
        placeholder="https://"
        initialValue="https://"
        confirmLabel="Add link"
        onSubmit={setUrl}
      />
    </>
  )
}

export const LinkUrl: Story = {
  render: () => <Demo />,
}
