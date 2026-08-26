import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CalloutVariant = 'info' | 'warning' | 'danger' | 'neutral' | 'pooled'

/**
 * Reusable admonition/callout, one consistent family across the app (formalizes the
 * brief's "Heads up" warning). Per the Algorand palette: info = blue, warning =
 * amber (navy/amber text, never white), danger = orange, neutral = inset/muted,
 * pooled = teal (the app-wide tone for pooled voting / staking pools, matching the
 * landing callout and the pooled figures on the account page).
 * Status text uses the themeable `*-strong` tokens so it stays legible in dark mode.
 */
const VARIANTS: Record<
  CalloutVariant,
  { container: string; icon: string; title: string; body: string; defaultIcon: ReactNode }
> = {
  info: {
    container: 'border-primary/30 border-l-[3px] border-l-primary bg-primary/10',
    icon: 'text-primary',
    title: 'text-foreground',
    body: 'text-muted-foreground',
    defaultIcon: <Info className="size-[18px]" />,
  },
  warning: {
    container: 'border-warning/50 bg-warning/15',
    icon: 'text-warning-strong',
    title: 'text-warning-strong',
    body: 'text-warning-strong',
    defaultIcon: <AlertTriangle className="size-[18px]" />,
  },
  danger: {
    container: 'border-destructive/40 border-l-[3px] border-l-destructive bg-destructive/10',
    icon: 'text-destructive-strong',
    title: 'text-destructive-strong',
    body: 'text-destructive-strong',
    defaultIcon: <AlertTriangle className="size-[18px]" />,
  },
  neutral: {
    container: 'border-border bg-muted',
    icon: 'text-muted-foreground',
    title: 'text-foreground',
    body: 'text-muted-foreground',
    defaultIcon: null,
  },
  // No left accent rule: pooled notes are explanatory rather than a status change.
  pooled: {
    container: 'border-algo-teal/20 bg-algo-teal/10',
    icon: 'text-teal-strong',
    title: 'text-foreground',
    body: 'text-muted-foreground',
    defaultIcon: <Info className="size-[18px]" />,
  },
}

export function Callout({
  variant = 'info',
  size = 'sm',
  title,
  icon,
  children,
  className,
}: {
  variant?: CalloutVariant
  /** `sm` (compact, for dialogs/inline) or `md` (prose scale, for docs). */
  size?: 'sm' | 'md'
  title?: ReactNode
  icon?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const v = VARIANTS[variant]
  const resolvedIcon = icon === undefined ? v.defaultIcon : icon
  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border font-sans',
        size === 'md' ? 'px-[18px] py-4' : 'px-4 py-3.5',
        v.container,
        className,
      )}
    >
      {resolvedIcon && <span className={cn('mt-px flex-none', v.icon)}>{resolvedIcon}</span>}
      <div className={cn('min-w-0 flex-1', size === 'md' ? 'text-[15px] leading-[1.55]' : 'text-sm leading-relaxed')}>
        {title && <div className={cn('font-semibold', v.title)}>{title}</div>}
        {children && <div className={cn(v.body, title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  )
}
