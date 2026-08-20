/**
 * Shared palette and share maths for the pooled-voting surfaces — the committee
 * page's card, the pools index, and the composition bar both render.
 *
 * Kept out of the component file so a pool keeps the same colour wherever it is
 * drawn, and so the bar module stays exports-components-only (fast refresh).
 */

/** Composition palette; theme-aware and cycled when a committee has more pools. */
const SEGMENT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

/** The grouped tail band — pools too small to get a segment of their own. */
export const TAIL_COLOR = 'var(--algo-navy-40)'

export const segmentColor = (index: number) => SEGMENT_COLORS[index % SEGMENT_COLORS.length]

/**
 * `part` as a percentage of `whole`. Undefined propagates: a share whose
 * denominator hasn't loaded is unknown, not zero, and callers render it as "—".
 */
export function pctOf(part: number, whole: number | undefined): number | undefined {
  if (whole === undefined) return undefined
  if (whole <= 0) return 0
  return (part / whole) * 100
}
