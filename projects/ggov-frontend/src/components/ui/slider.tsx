import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * Single-value range slider (shadcn "new-york"), over the `radix-ui` primitive already used by the
 * dialog/tooltip/dropdown wrappers in this directory — no new dependency.
 *
 * Kept single-thumb on purpose: the one caller (the registry-funding turnout assumption) is a scalar,
 * and a range API would be unexercised surface.
 */
export function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { className?: string }) {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'block size-4 rounded-full border border-primary/50 bg-background shadow-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      />
    </SliderPrimitive.Root>
  )
}
