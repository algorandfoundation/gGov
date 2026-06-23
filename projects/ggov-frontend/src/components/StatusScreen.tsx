import type { ReactNode } from 'react'
import { AlgorandLogo } from '@/components/Brand'
import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'

/**
 * Centered status screen for whole-page states (the 404 page, the in-app route
 * error boundary, and the top-level error catch-all). Deliberately
 * self-contained — no router or context dependencies — so it can render inside
 * the root `errorComponent`, which mounts outside AppProviders. Callers supply
 * their own navigation (`Link` or `<a>`) through `actions`, and `className`
 * tunes the container (e.g. a shorter min-height when nested in the app shell).
 */
export default function StatusScreen({
  title,
  description,
  message,
  actions,
  className,
}: {
  title: string
  description?: ReactNode
  /** Raw error text, shown verbatim (monospace) with a copy button. */
  message?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center', className)}>
      <AlgorandLogo className="size-10 text-primary" />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{title}</h1>
        {description && <p className="max-w-md text-muted-foreground">{description}</p>}
      </div>
      {message && (
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          {/* Mirrors the error dialog's message styling for a consistent look. */}
          <div className="max-h-48 w-full overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-left font-mono text-xs text-muted-foreground">
            {message}
          </div>
          <CopyButton value={message}>Copy error</CopyButton>
        </div>
      )}
      {actions && <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>}
    </div>
  )
}
