import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { TxButton } from '@/components/TxButtonContent'
import { useEditTopicMutation } from '@/hooks/mutations'

interface EditOptionsDialogProps {
  periodId: number
  /** Index of the topic being edited; used for the title and the on-chain call. */
  topicIndex: number
  /** Current on-chain options, used to seed the form. */
  initialOptions: string[]
  onClose: () => void
}

// A topic must keep at least this many options; Remove is disabled at the floor.
const MIN_OPTIONS = 2

/**
 * Edit the options of a single topic. Mounted only while a topic is being edited,
 * so it seeds its form state once from `initialOptions` on mount.
 *
 * Validation: at least two options, no blanks, no duplicates. Whitespace is trimmed
 * before saving, but a blank entry is surfaced as an error rather than silently
 * dropped — the operator decides whether to fill it in or remove the row.
 */
export function EditOptionsDialog({ periodId, topicIndex, initialOptions, onClose }: EditOptionsDialogProps) {
  const editTopicMutation = useEditTopicMutation()
  const [options, setOptions] = useState<string[]>(() =>
    initialOptions.length >= MIN_OPTIONS ? [...initialOptions] : [...initialOptions, '', ''].slice(0, MIN_OPTIONS),
  )

  const { trimmed, blankIdx, duplicateIdx, isValid } = useMemo(() => {
    const trimmed = options.map((o) => o.trim())

    const blankIdx = new Set<number>()
    trimmed.forEach((t, i) => {
      if (t === '') blankIdx.add(i)
    })

    const counts = new Map<string, number>()
    trimmed.forEach((t) => {
      if (t !== '') counts.set(t, (counts.get(t) ?? 0) + 1)
    })
    const duplicateIdx = new Set<number>()
    trimmed.forEach((t, i) => {
      if (t !== '' && (counts.get(t) ?? 0) > 1) duplicateIdx.add(i)
    })

    const isValid = options.length >= MIN_OPTIONS && blankIdx.size === 0 && duplicateIdx.size === 0
    return { trimmed, blankIdx, duplicateIdx, isValid }
  }, [options])

  function setOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, j) => (j === i ? value : o)))
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, j) => j !== i))
  }

  function moveOption(i: number, dir: -1 | 1) {
    setOptions((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function handleSave() {
    if (!isValid) return
    editTopicMutation.mutate({ periodId, topicIndex, options: trimmed }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Edit Topic {topicIndex + 1} Options</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            {options.map((opt, i) => {
              const invalid = blankIdx.has(i) || duplicateIdx.has(i)
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-col">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move option ${i + 1} up`}
                        onClick={() => moveOption(i, -1)}
                        disabled={i === 0}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move option ${i + 1} down`}
                        onClick={() => moveOption(i, 1)}
                        disabled={i === options.length - 1}
                      >
                        <ChevronDown />
                      </Button>
                    </div>
                    <Input
                      name={`topic-option-${i}`}
                      aria-label={`Option ${i + 1}`}
                      aria-invalid={invalid || undefined}
                      value={opt}
                      onChange={(e) => setOption(i, e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove option ${i + 1}`}
                      onClick={() => removeOption(i)}
                      disabled={options.length <= MIN_OPTIONS}
                    >
                      <X />
                    </Button>
                  </div>
                  {blankIdx.has(i) ? (
                    <p className="pl-8 text-xs text-destructive">Option cannot be empty.</p>
                  ) : duplicateIdx.has(i) ? (
                    <p className="pl-8 text-xs text-destructive">Duplicate option.</p>
                  ) : null}
                </div>
              )
            })}
          </div>
          <Button variant="outline" size="sm" onClick={() => setOptions((prev) => [...prev, ''])}>
            Add Option
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <TxButton
            onClick={handleSave}
            disabled={!isValid}
            pending={editTopicMutation.isPending}
            success={editTopicMutation.isSuccess}
            idleLabel="Save"
            pendingLabel="Saving…"
            confirmedLabel="Saved"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
