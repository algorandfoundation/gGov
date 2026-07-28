import * as React from 'react'
import { cn } from '@/lib/utils'

/** Card surface matching the vote/period pages (hairline border + sm shadow). */
export function Surface({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-card shadow-sm', className)} {...props} />
}
