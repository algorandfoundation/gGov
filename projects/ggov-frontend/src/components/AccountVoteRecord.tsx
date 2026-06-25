/* eslint-disable react-refresh/only-export-components */
import { AccountAvatar } from '@/components/AccountAvatar'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { classifyOption } from '@/utils/vote'
import { cn } from '@/lib/utils'

/** How the connected wallet relates to this account, driving the header tag. */
export type AccountVoteRole = 'self' | 'delegated' | 'direct'

export interface VoteAllocation {
  /** Option label as stored on-chain. */
  label: string
  /** Votes this account put on the option. */
  votes: number
  /** Share of the account's power on this topic, 0–100 (rounded). */
  pct: number
}

export interface AccountVoteTopic {
  /** 0-based topic index, rendered as the mono `T.0N` chip. */
  index: number
  title?: string
  /** Power spread across more than one option (advanced mode). */
  split: boolean
  allocations: VoteAllocation[]
}

export interface AccountVoteRecordProps {
  address: string
  role: AccountVoteRole
  /** The account's voting power exercised in the period. */
  total: number
  topics: AccountVoteTopic[]
}

/**
 * Maps an option label to its sentiment swatch/bar colour (a Tailwind `bg-*`
 * class): For/approve → green, Against → orange, Abstain/neutral → navy-40,
 * everything else (candidate names) → algo-blue.
 */
export function sentimentTone(label: string): string {
  switch (classifyOption(label)) {
    case 'yes':
      return 'bg-success'
    case 'no':
      return 'bg-algo-orange'
    case 'abstain':
      return 'bg-algo-navy-40'
    default:
      return 'bg-algo-blue'
  }
}

const ROLE_META: Record<AccountVoteRole, { label: string; className: string }> = {
  // Mirrors the AccountSelector / vote-warning language so delegation reads consistently.
  self: { label: 'Your account', className: 'bg-primary/10 text-primary dark:bg-algo-teal/15 dark:text-algo-teal' },
  delegated: { label: 'Delegated to you', className: 'bg-muted text-muted-foreground' },
  direct: { label: 'Voted directly', className: 'bg-warning/20 text-[#7A5A00] dark:text-warning' },
}

/** Small pill, matching TopicVoteCard's `ResultTag` (LEADING / YOUR VOTE) sizing. */
const PILL = 'shrink-0 rounded-full px-[7px] py-[2px] text-[10.5px] font-semibold tracking-[0.03em]'

/** Account name: resolved NFD name, falling back to the ellipsed address. */
function AccountName({ address }: { address: string }) {
  const { data: name } = useAddressName(address)
  return (
    <span className={cn('min-w-0 truncate text-[14px] font-medium text-foreground', !name && 'font-mono')}>
      {name ?? ellipseAddress(address, 6)}
    </span>
  )
}

/**
 * One account's final voting record in a period: a header (avatar + name +
 * context tag + total power) over per-topic allocation rows. A single-choice
 * (full-power) vote is one line; a split vote flags "Split" and renders each
 * allocation as its own line with a proportion bar. Long option labels wrap
 * while the vote figure stays pinned top-right.
 */
export default function AccountVoteRecord({ address, role, total, topics }: AccountVoteRecordProps) {
  const roleMeta = ROLE_META[role]
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-[11px] border-b bg-muted/50 px-[15px] py-[13px]">
        <AccountAvatar address={address} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[7px]">
            <AccountName address={address} />
            <span className={cn(PILL, roleMeta.className)}>{roleMeta.label}</span>
          </div>
          <div className="mt-[3px] text-[12px] text-muted-foreground">
            <strong className="tabular-nums text-foreground">{total.toLocaleString()}</strong> votes
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        {topics.map((topic) => {
          const indexLabel = `T.${String(topic.index + 1).padStart(2, '0')}`
          return (
            <div key={topic.index} className="border-b px-[15px] py-3 last:border-b-0">
              <div className="mb-[9px] flex items-baseline gap-2">
                <span className="shrink-0 rounded-[5px] bg-primary/10 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
                  {indexLabel}
                </span>
                <span className="min-w-0 flex-1 text-[13px] font-semibold text-foreground [overflow-wrap:anywhere]">
                  {topic.title}
                </span>
                {topic.split && (
                  <span className={cn(PILL, 'bg-warning/20 text-[#7A5A00] dark:text-warning')}>Split</span>
                )}
              </div>
              <div className="flex flex-col gap-[9px]">
                {topic.allocations.map((alloc, i) => {
                  const tone = sentimentTone(alloc.label)
                  return (
                    <div key={i}>
                      <div className="flex items-start gap-[9px]">
                        <span className={cn('mt-1 size-[9px] shrink-0 rounded-[3px]', tone)} />
                        <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                          {alloc.label}
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground">
                          <strong className="tabular-nums text-foreground">{alloc.votes.toLocaleString()}</strong> ·{' '}
                          {alloc.pct}%
                        </span>
                      </div>
                      {topic.split && (
                        <div className="ml-[18px] mt-1.5 h-[5px] overflow-hidden rounded-full bg-muted">
                          <div className={cn('h-full rounded-full', tone)} style={{ width: `${alloc.pct}%` }} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
