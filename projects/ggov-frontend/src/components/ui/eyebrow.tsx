import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Small uppercase, tracked label that sits above a heading (design-system
 * "Eyebrow"). Renders teal in dark mode where teal is the primary accent.
 */
export function Eyebrow({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground dark:text-algo-teal",
        className,
      )}
      {...props}
    />
  )
}
