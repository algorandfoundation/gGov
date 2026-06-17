import { useState } from "react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"

interface ClampedMarkdownProps {
  children: string
  /** Tailwind gradient `from-*` color matching the surface behind the text. */
  fadeFrom?: string
  /** Roughly how many lines to show before clamping. Defaults to 3. */
  lines?: number
  className?: string
}

// Matches the ~1.5rem line-height of the markdown body text.
const LINE_HEIGHT_REM = 1.5
// Rough characters-per-line at the body text's width, used to estimate whether
// content overflows the collapsed height without measuring the DOM.
const CHARS_PER_LINE = 47

/**
 * Markdown description that collapses to roughly `lines` lines with a fade-out and
 * a "Show more…" toggle, matching the homepage period cards. Short content that
 * fits within the collapsed height renders without a toggle.
 */
export function ClampedMarkdown({ children, fadeFrom = "from-background", lines = 3, className }: ClampedMarkdownProps) {
  const [expanded, setExpanded] = useState(false)

  // Roughly the collapsed height; short descriptions don't need a toggle.
  const isLong = children.length > lines * CHARS_PER_LINE || children.split("\n").length > lines

  return (
    <div className={className}>
      <div
        className={!isLong || expanded ? undefined : "relative overflow-hidden"}
        style={!isLong || expanded ? undefined : { maxHeight: `${lines * LINE_HEIGHT_REM}rem` }}
      >
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
