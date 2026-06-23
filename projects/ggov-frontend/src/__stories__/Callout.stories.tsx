import type { Meta, StoryObj } from '@storybook/react'
import { Callout } from '@/components/ui/callout'

/**
 * The reusable callout family (formalizes the brief's "Heads up"): warning (amber),
 * info (blue), danger (orange), neutral (inset) — one consistent component, status
 * text via themeable `*-strong` tokens so it stays legible in dark mode.
 */
const meta: Meta<typeof Callout> = {
  title: 'MISC_DIALOGS/Callouts',
  component: Callout,
}
export default meta
type Story = StoryObj<typeof Callout>

export const Family: Story = {
  render: () => (
    <div className="flex w-[460px] max-w-full flex-col gap-3">
      <Callout variant="warning" title="Heads up">
        Edits lock once the first vote is cast.
      </Callout>
      <Callout variant="info" title="Good to know">
        Voting power is the number of blocks you produced this window.
      </Callout>
      <Callout variant="danger" title="This can't be undone">
        Removing a topic deletes its options permanently.
      </Callout>
      <Callout variant="neutral">A neutral, inset note for low-emphasis context.</Callout>
    </div>
  ),
}
