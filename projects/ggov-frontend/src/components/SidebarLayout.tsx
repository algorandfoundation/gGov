import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SidebarLayoutProps {
  /** Primary page content. */
  children: ReactNode
  /** Content rendered in the secondary sidebar column. */
  sidebar: ReactNode
  /** Which side the sidebar sits on at desktop widths. Defaults to "right". */
  side?: 'left' | 'right'
  className?: string
  sidebarClassName?: string
}

/**
 * Generic two-column page layout: a flexible main column alongside a fixed-width
 * sidebar that sticks while the main content scrolls. Columns stack on mobile
 * (sidebar always rendered after the main content in source order, so it reads
 * last on small screens regardless of the desktop side).
 */
export default function SidebarLayout({
  children,
  sidebar,
  side = 'right',
  className,
  sidebarClassName,
}: SidebarLayoutProps) {
  return (
    <div className={cn('flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8', className)}>
      <main className={cn('min-w-0 flex-1', side === 'left' && 'lg:order-2')}>{children}</main>
      <aside
        className={cn(
          'w-full lg:sticky lg:top-6 lg:w-80 lg:shrink-0',
          side === 'left' && 'lg:order-1',
          sidebarClassName,
        )}
      >
        {sidebar}
      </aside>
    </div>
  )
}
