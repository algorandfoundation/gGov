import { Badge } from '@/components/ui/badge'
import { periodStatus, type PeriodStatus } from '@/utils/time'
import { cn } from '@/lib/utils'

const statusConfig: Record<PeriodStatus, { label: string; className: string }> = {
  upcoming: { label: 'Upcoming', className: 'bg-accent text-accent-foreground hover:bg-accent' },
  active: { label: 'Active', className: 'bg-primary/15 text-primary hover:bg-primary/15' },
  ended: { label: 'Ended', className: 'bg-muted text-muted-foreground hover:bg-muted' },
}

interface Props {
  votingStart: number
  votingEnd: number
}

export default function PeriodStatusBadge({ votingStart, votingEnd }: Props) {
  const status = periodStatus(votingStart, votingEnd)
  const config = statusConfig[status]
  return (
    <Badge variant="secondary" className={cn(config.className, 'border-0')}>
      {config.label}
    </Badge>
  )
}
