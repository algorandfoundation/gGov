import { useState } from "react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"

interface ClampedMarkdownProps {
  children: string
  /** Tailwind gradient `from-*` color matching the surface behind the text. */
  fadeFrom?: string
  className?: string
}

/**
 * Markdown description that collapses to roughly three lines with a fade-out and
 * a "Show more…" toggle, matching the homepage period cards. Short content that
 * fits within the collapsed height renders without a toggle.
 */
export function ClampedMarkdown({ children, fadeFrom = "from-background", className }: ClampedMarkdownProps) {
  const [expanded, setExpanded] = useState(false)

  // Roughly the collapsed height (~3 lines); short descriptions don't need a toggle.
  const isLong = children.length > 140 || children.split("\n").length > 3

  return (
    <div className={className}>
      <div className={!isLong || expanded ? undefined : "relative max-h-[4.5rem] overflow-hidden"}>
        <MarkdownContent>{children}</MarkdownContent>
        {isLong && !expanded && (
          <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t to-transparent", fadeFrom)} />
        )}
      </div>
      {isLong && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-primary hover:underline"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
        >
          {expanded ? "Show less" : "Show more…"}
        </button>
      )}
    </div>
  )
}
