import { cn } from '@/lib/utils'

interface BlockGridProps {
  /** Number of "on" cells (blocks produced, scaled to the grid). */
  filled: number
  /** Total cells in the grid. */
  total?: number
  /** Columns in the CSS grid. */
  columns?: number
  /** Cell side length in pixels. */
  cell?: number
  className?: string
}

/**
 * Block-production visualization: a grid of square cells with `filled` of them
 * lit in the brand accent. Custom (not a shared DS primitive) per the design.
 */
export function BlockGrid({ filled, total = 48, columns = 16, cell = 9, className }: BlockGridProps) {
  const lit = Math.max(0, Math.min(total, Math.round(filled)))
  return (
    <div
      aria-hidden
      className={cn('grid', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, ${cell}px)`, gap: 3 }}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn('rounded-[2px]', i < lit ? 'bg-algo-blue dark:bg-algo-teal' : 'bg-muted dark:bg-white/10')}
          style={{ width: cell, height: cell }}
        />
      ))}
    </div>
  )
}
