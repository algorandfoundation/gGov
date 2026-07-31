import { AccountAvatar } from '@/components/AccountAvatar'
import AccountVoteRecord, { type AccountVoteRecordProps } from '@/components/AccountVoteRecord'
import { plural } from '@/utils/periodTerms'

interface VotingRecordSectionProps {
  /** The connected wallet, shown on the summary banner. */
  activeAddress: string
  /** One per account the wallet can act for that cast a vote (own + delegated). */
  records: AccountVoteRecordProps[]
  /** Number of ballot items in the period (the "across M topics" figure). */
  topicCount: number
  /** Singular noun for one ballot item — `candidate` on an election period. */
  topicNoun?: string
}

/**
 * Ended-period results section: a "you voted" summary banner over a two-up grid
 * of {@link AccountVoteRecord} cards — one per account the connected wallet can
 * act for (its own accounts plus any delegated to it). Render only when the
 * wallet is connected and at least one of those accounts voted.
 */
export default function VotingRecordSection({
  activeAddress,
  records,
  topicCount,
  topicNoun = 'topic',
}: VotingRecordSectionProps) {
  const n = records.length
  const recordTotal = records.reduce((sum, r) => sum + r.total, 0)
  const delegatedVoted = records.filter((r) => r.role !== 'self').length
  const ownVoted = records.some((r) => r.role === 'self')

  const topicsLabel = plural(topicCount, topicNoun)
  // `recordTotal` is the combined voting power exercised — not a count of ballots
  // summed across topics (each topic re-spends the same power), so frame it as a weight.
  const weightLabel = n === 1 ? 'a weight of' : 'a combined weight of'
  const title = n === 1 ? 'You voted in this period' : `You voted with ${n} accounts in this period`
  const detail = ownVoted
    ? delegatedVoted > 0
      ? `Your account plus ${delegatedVoted} delegated to you voted with ${weightLabel} ${recordTotal.toLocaleString()} across ${topicsLabel}`
      : `Your account voted with ${weightLabel} ${recordTotal.toLocaleString()} across ${topicsLabel}`
    : `${delegatedVoted} account${delegatedVoted === 1 ? '' : 's'} delegated to you voted with ${weightLabel} ${recordTotal.toLocaleString()} across ${topicsLabel}`

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-md border border-l-[3px] border-l-success bg-card px-[18px] py-3.5">
        <AccountAvatar address={activeAddress} size={32} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-foreground">{title}</div>
          <div className="text-[12.5px] text-muted-foreground">{detail} · recorded on-chain</div>
        </div>
      </div>

      <div id="voting-record" className="scroll-mt-6">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold">Your voting record</h2>
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {n} account{n === 1 ? '' : 's'} · <span className="tabular-nums">{recordTotal.toLocaleString()}</span> votes
          </span>
        </div>
        <p className="mb-4 text-[13px] text-muted-foreground">
          How each account you can act for voted — including accounts delegated to you.
        </p>
        <div className="grid gap-3.5 sm:grid-cols-2">
          {records.map((record) => (
            <AccountVoteRecord key={record.address} {...record} />
          ))}
        </div>
      </div>
    </div>
  )
}
