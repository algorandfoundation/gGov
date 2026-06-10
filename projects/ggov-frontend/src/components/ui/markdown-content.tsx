import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

/**
 * Shared prose styling used by both the rendered markdown (display sites) and the
 * TipTap editor content, so authored content looks identical to what voters see.
 * Prose neutral colors are mapped to the app theme tokens so it matches light/dark
 * automatically (no need for dark:prose-invert).
 */
export const proseClass = cn(
  "prose prose-sm max-w-none break-words",
  "prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1",
  "prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
  "prose-a:text-primary prose-a:font-medium prose-a:no-underline hover:prose-a:underline",
  "[--tw-prose-body:var(--foreground)] [--tw-prose-headings:var(--foreground)]",
  "[--tw-prose-bold:var(--foreground)] [--tw-prose-bullets:var(--muted-foreground)]",
  "[--tw-prose-counters:var(--muted-foreground)] [--tw-prose-code:var(--foreground)]",
  "[--tw-prose-quotes:var(--muted-foreground)] [--tw-prose-quote-borders:var(--border)]",
  "[--tw-prose-hr:var(--border)] [--tw-prose-pre-bg:var(--muted)] [--tw-prose-pre-code:var(--foreground)]",
)

interface MarkdownContentProps {
  children: string
  className?: string
}

export function MarkdownContent({ children, className }: MarkdownContentProps) {
  return (
    <div className={cn(proseClass, className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
