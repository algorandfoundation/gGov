import { cn } from "@/lib/utils"

interface ProgressBarProps {
  /** Filled percentage, 0–100. */
  value: number
  /** Track fill colour. "sky" is the brand accent (blue in light, teal in dark). */
  tone?: "sky" | "primary"
  /** Bar height in pixels. */
  height?: number
  className?: string
}

/**
 * Thin progress/meter bar (design-system "ProgressBar"). Generalises the inline
 * tally bar previously hand-rolled in TopicVoteCard.
 */
export function ProgressBar({ value, tone = "sky", height = 8, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-muted", className)}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          tone === "sky" ? "bg-algo-blue dark:bg-algo-teal" : "bg-primary",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
