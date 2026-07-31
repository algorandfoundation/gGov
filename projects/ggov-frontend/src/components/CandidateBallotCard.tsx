import { Avatar, avatarTone } from '@/components/ui/avatar'
import { ClampedMarkdown } from '@/components/ui/clamped-markdown'
import { classifyOption, type OptionSentiment } from '@/utils/vote'
import { cn } from '@/lib/utils'

/**
 * Chip styling per sentiment, selected and not. Support/Veto read as the score they
 * carry (green adds, orange subtracts); everything the classifier doesn't recognize
 * falls back to the neutral chip rather than borrowing a sentiment's colour.
 */
const CHIP: Record<OptionSentiment, string> = {
  yes: 'border-success/[0.55] bg-success/[0.16] text-success-strong',
  no: 'border-destructive/50 bg-destructive/[0.13] text-destructive-strong',
  abstain: 'border-border bg-muted text-muted-foreground',
  other: 'border-border bg-muted text-foreground',
}

/** Tint the whole card carries once scored, echoing the chosen chip. */
const CARD: Record<OptionSentiment, string> = {
  yes: 'border-success/[0.55]',
  no: 'border-destructive/50',
  abstain: 'border-border',
  other: 'border-border',
}

interface CandidateBallotCardProps {
  /** Candidate handle — the topic-body title. */
  name: string
  /** The candidate's statement (the topic body), as markdown. */
  statement?: string
  /** On-chain option labels for this candidate — Support / Veto / Abstain. */
  options: string[]
  /** Index of the chosen option, or -1 when the candidate is unscored. */
  selectedOption: number
  onSelect: (optionIdx: number) => void
}

/**
 * One candidate on an election ballot: avatar, name, their statement, and the
 * Support / Veto / Abstain chips that score them.
 *
 * This is the `select`-mode counterpart to {@link TopicVoteCard} for a candidate
 * topic. A candidate is scored, not chosen between — so the ballot reads as three
 * sentiment chips per person rather than a radio list of "options", and the card
 * itself picks up the tint of the score once given.
 */
export default function CandidateBallotCard({
  name,
  statement,
  options,
  selectedOption,
  onSelect,
}: CandidateBallotCardProps) {
  const picked = selectedOption >= 0 ? classifyOption(options[selectedOption] ?? '') : undefined

  return (
    <div className={cn('rounded-xl border bg-card transition-colors', picked ? CARD[picked] : 'border-border')}>
      <div className="flex items-center gap-3 px-4 pt-[13px]">
        <Avatar name={name} tone={avatarTone(name)} size={32} />
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{name}</span>
      </div>

      <div className="px-4 pb-[13px] pt-[11px]">
        {statement && (
          <ClampedMarkdown lines={3} fadeFrom="from-card" className="text-[13px] text-muted-foreground">
            {statement}
          </ClampedMarkdown>
        )}
        {/* Narrow screens give the chips the full width as a 3-up grid with 44px
            touch targets; from `sm` they sit inline at the end of the row. */}
        <div
          className={cn(
            'flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-x-3',
            statement && 'mt-2.5',
          )}
        >
          <span className="text-[11.5px] text-muted-foreground">Your vote</span>
          <div
            className="grid gap-1.5 sm:flex sm:flex-wrap sm:items-center"
            style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, minmax(0, 1fr))` }}
          >
            {options.map((option, optIdx) => {
              const selected = selectedOption === optIdx
              const sentiment = classifyOption(option)
              return (
                <button
                  key={optIdx}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(optIdx)}
                  className={cn(
                    'min-h-11 cursor-pointer rounded-md px-3 text-xs font-semibold transition-colors sm:min-h-0 sm:rounded-full sm:py-1.5',
                    selected
                      ? cn('border-[1.5px]', CHIP[sentiment])
                      : 'border border-border bg-background text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {option}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
