import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Dashed empty-state panel. */
export function EmptyPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-4 py-7 text-center text-[13px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}
