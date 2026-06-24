import type { Meta, StoryObj } from '@storybook/react'
import { within, userEvent } from 'storybook/test'
import { Vote, Users, BookOpen } from 'lucide-react'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

/**
 * §4.4 — the Radix-based side sheet / drawer (the one overlay that animates, traps
 * focus, and closes on Esc). Used for the mobile nav drawer and the docs nav.
 */
const meta: Meta<typeof Sheet> = {
  title: 'MISC_DIALOGS/4.4 Sheet (drawer)',
  component: Sheet,
}
export default meta
type Story = StoryObj<typeof Sheet>

const NAV = [
  { label: 'Vote', icon: Vote },
  { label: 'Committees', icon: Users },
  { label: 'Docs', icon: BookOpen },
]

function SheetDemo({ side }: { side: 'left' | 'right' }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open {side} drawer</Button>
      </SheetTrigger>
      <SheetContent side={side} className="w-[280px]">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Mobile navigation drawer.</SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-1 p-2">
          {NAV.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  )
}

export const LeftDrawer: Story = {
  render: () => <SheetDemo side="left" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
  },
}

export const RightDrawer: Story = {
  render: () => <SheetDemo side="right" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
  },
}
