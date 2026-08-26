import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Lock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { TxButton } from '@/components/TxButtonContent'
import { useEditTopicMutation } from '@/hooks/mutations'
import { ABSTAIN_OPTION, MIN_CUSTOM_OPTIONS, findOptionIssues, withAbstain } from '@/utils/topicOptions'

interface EditOptionsDialogProps {
  periodId: number
  /** Index of the topic being edited; used for the title and the on-chain call. */
  topicIndex: number
  /** Current on-chain options, used to seed the form. */
  initialOptions: string[]
  /**
   * Capitalised noun for the thing being edited. An election period's options are
   * fixed, so today the caller only opens this for a standard period's topics —
   * the prop keeps the title honest if that ever changes.
   */
  itemNoun?: string
  onClose: () => void
}

/**
 * Edit the options of a single topic. Mounted only while a topic is being edited,
 * so it seeds its form state once from `initialOptions` on mount.
 *
 * State holds only the custom options: Abstain renders as a locked last row, and is appended
 * to the list on save.
 *
 * Validation: at least `MIN_CUSTOM_OPTIONS` options, no blanks, no duplicates, no typed
 * Abstain. Whitespace is trimmed before saving, but a blank entry is surfaced as an error
 * rather than silently dropped — the operator decides whether to fill it in or remove it.
 */
export function EditOptionsDialog({
  periodId,
  topicIndex,
  initialOptions,
  itemNoun = 'Topic',
  onClose,
}: EditOptionsDialogProps) {
  const editTopicMutation = useEditTopicMutation()
  const [options, setOptions] = useState<string[]>(() => {
    // `ensureValidOptions` at the smart contract level, asserts Abstain is last *and* appears nowhere else,
    // so the head is exactly the custom options — nothing to check in what we drop. `withAbstain` puts it back.
    const custom = initialOptions.slice(0, -1)
    return custom.length >= MIN_CUSTOM_OPTIONS ? custom : [...custom, '', ''].slice(0, MIN_CUSTOM_OPTIONS)
  })

  const { trimmed, blankIdx, duplicateIdx, abstainIdx } = useMemo(() => findOptionIssues(options), [options])
  const isValid =
    options.length >= MIN_CUSTOM_OPTIONS && blankIdx.size === 0 && duplicateIdx.size === 0 && abstainIdx.size === 0

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
    editTopicMutation.mutate({ periodId, topicIndex, options: withAbstain(trimmed) }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle>
            Edit {itemNoun} {topicIndex + 1} options
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            {options.map((opt, i) => {
              const invalid = blankIdx.has(i) || duplicateIdx.has(i) || abstainIdx.has(i)
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
                    >
                      <X />
                    </Button>
                  </div>
                  {blankIdx.has(i) ? (
                    <p className="pl-8 text-xs text-destructive">Option cannot be empty.</p>
                  ) : duplicateIdx.has(i) ? (
                    <p className="pl-8 text-xs text-destructive">Duplicate option.</p>
                  ) : abstainIdx.has(i) ? (
                    <p className="pl-8 text-xs text-destructive">
                      {ABSTAIN_OPTION} is always the last option — it can't be typed here.
                    </p>
                  ) : null}
                </div>
              )
            })}
            {/* Fixed last option: a spacer for the move column, a lock for the remove one. */}
            <div className="flex items-center gap-1.5">
              <div className="w-6 shrink-0" />
              <Input name="topic-option-abstain" aria-label={ABSTAIN_OPTION} value={ABSTAIN_OPTION} readOnly />
              <div className="flex size-8 shrink-0 items-center justify-center">
                <Lock className="size-4 text-muted-foreground" />
              </div>
            </div>
            {options.length < MIN_CUSTOM_OPTIONS && (
              <p className="pl-8 text-xs text-destructive">
                A topic needs at least {MIN_CUSTOM_OPTIONS} options besides {ABSTAIN_OPTION}.
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setOptions((prev) => [...prev, ''])}>
            Add option
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
