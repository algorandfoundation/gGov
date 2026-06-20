/** Compact number, e.g. 48_200_000 → "48.2M", 1_204 → "1,204". */
export function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 100_000) return `${Math.round(n / 1_000)}K`
  return n.toLocaleString()
}

/** Block-window range, e.g. "48.2M–51.2M". */
export function formatBlockRange(start: number, end: number): string {
  return `${formatCompact(start)}–${formatCompact(end)}`
}

/**
 * Flatten markdown to a single line of plain text for clipped previews (hero +
 * table rows), where rendered block elements would break the layout. Strips the
 * common inline/heading/list/link/code tokens and collapses whitespace.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // list bullets
    .replace(/[*_~]+/g, '') // emphasis markers
    .replace(/\s+/g, ' ')
    .trim()
}
