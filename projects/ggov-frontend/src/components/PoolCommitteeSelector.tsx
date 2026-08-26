import { Check, ChevronDown } from 'lucide-react'
import type { CommitteeOption } from '@/hooks/queries'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tag } from '@/components/ui/tag'
import { formatBlockRange } from '@/utils/format'
import { cn } from '@/lib/utils'

/**
 * Which line leads. The two pooled surfaces show the same list and mean the same
 * thing by it, but lead with different halves: the index is browsing committees
 * ("Committee", block range on top), the pool page is choosing a ballot to scope
 * its voting record to ("Selected period", period label on top).
 */
export type SelectorVariant = 'committee' | 'period'

interface PoolCommitteeSelectorProps {
  committees: CommitteeOption[]
  selected: CommitteeOption | undefined
  /** Committee id (base64url) → "Period 19" / "Periods 18, 19", when one used it. */
  periodLabels: Map<string, string>
  loading: boolean
  variant?: SelectorVariant
  /** Navigate to the committee just picked. The caller owns the destination route. */
  onSelect: (committeeId: string) => void
  className?: string
}

/** The two lines of a row, in the order this variant reads them. */
function rowLines(
  committee: CommitteeOption,
  periodLabels: Map<string, string>,
  variant: SelectorVariant,
): { lead: string; sub: string; leadMono: boolean } {
  const range = formatBlockRange(committee.periodStart, committee.periodEnd)
  const periodLabel = periodLabels.get(committee.idBase64Url)
  if (variant === 'period') {
    // No period used this window yet, so there is no ballot to name — the range
    // is the only identity the committee has, and it leads rather than repeating.
    return periodLabel
      ? { lead: periodLabel, sub: range, leadMono: false }
      : { lead: range, sub: 'No period yet', leadMono: true }
  }
  // A window's length is already implied by the range on the lead line, so the
  // subtitle spends itself on what the range cannot say: whether a ballot ran here.
  return { lead: range, sub: periodLabel ?? 'Not used by a period', leadMono: true }
}

/**
 * The committee picker shared by the pooled surfaces — the pools index and one
 * pool's detail page.
 *
 * Picking navigates rather than setting state: a committee's pool composition,
 * and a pool's standing within it, are each their own URL, so a selection can be
 * linked and the back button steps through the ones already seen.
 */
export default function PoolCommitteeSelector({
  committees,
  selected,
  periodLabels,
  loading,
  variant = 'committee',
  onSelect,
  className,
}: PoolCommitteeSelectorProps) {
  // Committees come back newest-first, so the head is the live window.
  const currentId = committees[0]?.idBase64Url

  if (loading && !selected) return <Skeleton className={cn('h-[52px] w-full sm:w-[210px]', className)} />

  const trigger = selected ? rowLines(selected, periodLabels, variant) : undefined

  return (
    <div className={cn('w-full sm:w-auto', className)}>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {variant === 'period' ? 'Selected period' : 'Committee'}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={committees.length === 0}
          className="group flex min-h-12 w-full items-center justify-between gap-2.5 rounded-md border border-input bg-background px-3.5 py-2 text-left transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={cn('truncate text-[13px] font-semibold', trigger?.leadMono && 'font-mono')}>
              {trigger?.lead ?? '—'}
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">{trigger?.sub ?? 'No committee'}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-[288px] overflow-y-auto">
          {committees.map((c) => {
            const { lead, sub, leadMono } = rowLines(c, periodLabels, variant)
            return (
              <DropdownMenuItem
                key={c.idBase64Url}
                onSelect={() => onSelect(c.idBase64Url)}
                className="gap-2.5 px-3 py-2.5"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      'truncate text-[13px] font-semibold text-algo-blue dark:text-algo-teal',
                      leadMono && 'font-mono',
                    )}
                  >
                    {lead}
                  </span>
                  <span className="truncate text-[11.5px] text-muted-foreground">{sub}</span>
                </span>
                {c.idBase64Url === currentId && (
                  <Tag tone="teal" className="shrink-0 px-2 py-0.5 text-[10px]">
                    Current
                  </Tag>
                )}
                {c.idBase64Url === selected?.idBase64Url && (
                  <Check className="size-4 shrink-0 !text-algo-blue dark:!text-algo-teal" />
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
