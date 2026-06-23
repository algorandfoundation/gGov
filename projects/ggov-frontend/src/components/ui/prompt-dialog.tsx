import { useEffect, useState, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

/**
 * Branded single-field prompt — the on-system replacement for `window.prompt` (used
 * for the markdown editor's link URL). Labeled input with a leading icon affix;
 * submits on Enter. The value semantics are the caller's: e.g. "" can mean "remove".
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  icon,
  confirmLabel = "Save",
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  label: string
  placeholder?: string
  initialValue?: string
  icon?: ReactNode
  confirmLabel?: string
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)
  // Re-seed each time the dialog opens.
  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  function submit() {
    onSubmit(value)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="space-y-2"
        >
          <Label htmlFor="prompt-dialog-input">{label}</Label>
          <div className="border-input focus-within:border-primary focus-within:ring-ring/30 flex items-center gap-2 rounded-md border px-3 focus-within:ring-[3px]">
            <span className="text-muted-foreground flex-none">{icon ?? <Link2 className="size-4" />}</span>
            <input
              id="prompt-dialog-input"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="flex-1 bg-transparent py-2.5 font-mono text-sm outline-none"
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
