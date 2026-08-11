import { Badge } from '@/components/ui/badge'
import { periodStatus, type PeriodStatus } from '@/utils/time'
import { cn } from '@/lib/utils'

/** `--accent` and `--muted` are the same hex in light mode, so `upcoming` cannot use `bg-accent`
 *  without reading as `ended`. TODO(FLAG): tone `ended` by result, once pass/reject is derivable
 *  on-chain. */
const STATUS_TONE: Record<PeriodStatus, string> = {
  upcoming: 'border-transparent bg-primary/10 text-primary dark:bg-algo-blue dark:text-white',
  active: 'border-transparent bg-algo-teal text-[#001324]',
  ended: 'border-transparent bg-muted text-muted-foreground',
}

/** "Closed" matches the filter tabs and the detail/results copy. */
const STATUS_LABEL: Record<PeriodStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  ended: 'Closed',
}

/** Takes whichever the caller already has — list rows compute `status` anyway, detail pages don't. */
type Props = { className?: string } & ({ status: PeriodStatus } | { votingStart: number; votingEnd: number })

export default function PeriodStatusBadge(props: Props) {
  const status = 'status' in props ? props.status : periodStatus(props.votingStart, props.votingEnd)
  return <Badge className={cn(STATUS_TONE[status], props.className)}>{STATUS_LABEL[status]}</Badge>
}
