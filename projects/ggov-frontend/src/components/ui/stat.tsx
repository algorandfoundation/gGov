import { Eyebrow } from "@/components/ui/eyebrow"
import { cn } from "@/lib/utils"

interface StatProps {
  /** Uppercase label above the value. */
  eyebrow?: string
  value: React.ReactNode
  caption?: React.ReactNode
  /** CSS colour for the value (e.g. "var(--algo-blue)"). Defaults to foreground. */
  solidColor?: string
  /** Value font size in pixels. */
  size?: number
  className?: string
}

/**
 * Eyebrow + large display value + caption (design-system "Stat").
 */
export function Stat({ eyebrow, value, caption, solidColor, size = 40, className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <div
        className="font-display font-bold leading-none tabular-nums"
        style={{ fontSize: size, color: solidColor }}
      >
        {value}
      </div>
      {caption && <p className="text-sm leading-snug text-muted-foreground">{caption}</p>}
    </div>
  )
}
