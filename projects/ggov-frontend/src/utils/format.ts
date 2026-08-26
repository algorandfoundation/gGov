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
 * A pooled/approximate vote figure, e.g. 4099.36 → "4,099.36". Always two
 * decimals, because a pooled share is a fraction of a pool's power rather than a
 * whole-block count — see `hooks/fracQueries.ts`. Render it behind a "≈".
 */
export function formatApprox(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

/**
 * µAlgo as ALGO, e.g. 57_800n → "0.0578", 5_000_000n → "5". Trailing zeros are trimmed, so a round
 * figure reads as one; the unit is left to the caller, which usually renders it as a separate,
 * quieter element.
 *
 * Six decimals is the full µAlgo precision and never rounds, which matters where the number is a
 * funding requirement — a display that rounded down would understate a shortfall.
 */
export function formatAlgo(microAlgos: bigint): string {
  const negative = microAlgos < 0n
  const abs = negative ? -microAlgos : microAlgos
  const whole = abs / 1_000_000n
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return `${sign}${whole.toLocaleString()}${fraction ? `.${fraction}` : ''}`
}
