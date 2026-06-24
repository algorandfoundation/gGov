import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Branded confirm dialog — the on-system replacement for `window.confirm`. Leads with
 * a severity icon in a tinted circle (orange for destructive) + title + body, and a
 * Cancel / confirm footer. Buttons go full-width and stack on mobile (primary on top).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = true,
  pending = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  icon?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  pending?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'flex size-9 flex-none items-center justify-center rounded-full',
              destructive ? 'bg-destructive/10 text-destructive-strong' : 'bg-primary/10 text-primary',
            )}
          >
            {icon ?? <Trash2 className="size-[19px]" />}
          </span>
          <DialogHeader className="min-w-0 flex-1 text-left sm:text-left">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            className="w-full sm:w-auto"
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
