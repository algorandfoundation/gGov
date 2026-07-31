import { useParams, Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { Shield } from 'lucide-react'
import {
  usePeriod,
  usePeriodBody,
  useTopicBodies,
  useCommittee,
  useVoters,
  useVoteRecord,
  toBase64Url,
} from '@/hooks/queries'
import SidebarLayout from '@/components/SidebarLayout'
import BackButton from '@/components/BackButton'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import TopicVoteCard from '@/components/TopicVoteCard'
import TurnoutCard from '@/components/TurnoutCard'
import ElectionResults, { type ElectionCandidate } from '@/components/ElectionResults'
import { groupCandidates, type Election } from 'ggov-sdk'
import { InfoRow } from '@/components/PeriodInfoCard'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { periodStatus, formatMonthDayYear } from '@/utils/time'
import { formatBlockRange } from '@/utils/format'
import { periodCountLabel, periodTerms, plural } from '@/utils/periodTerms'
import { tallyBallot, singleChoiceIndex } from '@/utils/vote'
import { cn } from '@/lib/utils'

/** "How scoring works" sidebar card (elections only). */
function ScoringCard({ elect }: { elect: Election[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Eyebrow>How scoring works</Eyebrow>
      <div className="mt-3.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-success/15 font-display text-[13px] font-bold text-success-strong">
            +1
          </span>
          <span className="text-[13.5px] text-muted-foreground">
            Each <strong className="text-foreground">Support</strong> vote adds to the score
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-[26px] shrink-0 place-items-center rounded-md font-display text-[13px] font-bold"
            style={{ background: 'rgba(255,127,72,0.13)', color: '#C24A1E' }}
          >
            −1
          </span>
          <span className="text-[13.5px] text-muted-foreground">
            Each <strong className="text-foreground">Against</strong> vote subtracts from it
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-muted/50 font-display text-[13px] font-bold text-muted-foreground">
            0
          </span>
          <span className="text-[13.5px] text-muted-foreground">
            <strong className="text-foreground">Abstain</strong> has no effect
          </span>
        </div>
      </div>
      <div className="mt-3.5 border-t border-border pt-3 text-[13px] leading-snug text-muted-foreground">
        {elect.length === 1 ? (
          <>
            Candidates are ranked by score; the top <strong className="text-foreground">{elect[0].s}</strong> lead for a
            seat.
          </>
        ) : (
          <>
            Each election is ranked <strong className="text-foreground">separately</strong> — a candidate competes only
            against others in the same election, and each election fills its own seats.
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Read-only Period Results page (`/vote/period/:periodId/results`). The layout is
 * chosen by period type: an election (period body has `elect`) shows one ranked
 * candidate list with a seat cutoff per election it declares; any other period shows
 * per-topic tally cards. Election results are also shown live while the period is
 * active (the in-progress order); standard results are post-close only.
 */
export default function VotePeriodResults() {
  const { periodId: pidParam } = useParams({ strict: false })
  const periodId = Number(pidParam)
  const { activeAddress } = useWallet()

  const { data: period, isLoading } = usePeriod(periodId)
  const { data: periodBody } = usePeriodBody(periodId)
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0)
  const committeeIdB64 = period ? toBase64Url(period.committeeId) : undefined
  const { data: committee } = useCommittee(committeeIdB64)
  const { data: voters } = useVoters(periodId)
  const { data: voteRecord } = useVoteRecord(periodId, activeAddress)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (!period) return <p className="text-muted-foreground">Period not found.</p>

  const status = periodStatus(period.votingStart, period.votingEnd)
  const isEnded = status === 'ended'
  const elect = periodBody?.elect
  const terms = periodTerms(elect)
  const isElection = terms.isElection
  // Elections expose the in-progress order while active; standard results
  // are post-close only.
  const live = isElection && status === 'active'
  const showResults = isEnded || live

  const header = (
    <div className="flex items-center gap-3">
      <BackButton to={`/vote/period/${periodId}`} />
      <h1 className="text-2xl font-bold">{periodBody?.title ?? `Period ${periodId}`}</h1>
      <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
    </div>
  )

  if (!showResults) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">
            Results aren't available yet — voting {status === 'upcoming' ? "hasn't opened" : 'is still open'}.
          </p>
          <Button asChild variant="outline" className="mt-4">
            <Link to="/vote/period/$periodId" params={{ periodId: String(periodId) }}>
              Go to the period
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const periodVotesCast = period.topics.reduce(
    (max, [, tallies]) =>
      Math.max(
        max,
        tallies.reduce((a, b) => a + b, 0),
      ),
    0,
  )
  const governorsVoted = voters?.length ?? 0

  // Bucket the candidates into their elections by each topic body's `e` tag. Candidates whose
  // tag is missing or names no declared election are left out of every group on purpose — they
  // surface below as "unassigned" rather than silently ranking in the first election.
  const groups = elect ? groupCandidates(period.topics, topicBodies, elect) : []
  const toCandidate = ({
    name,
    options,
    tallies,
    topicIndex,
  }: (typeof groups)[number]['candidates'][number]): ElectionCandidate => {
    // tallyBallot classifies free-form labels into yes/no/abstain sentiment;
    // for an election those map to Support / Against / Abstain.
    const { yes, no, abstain } = tallyBallot(options, tallies)
    return { name: name ?? `Candidate ${topicIndex + 1}`, support: yes, against: no, abstain }
  }
  const groupedCount = groups.reduce((n, g) => n + g.candidates.length, 0)
  const unassignedCount = isElection ? period.topics.length - groupedCount : 0

  const metaCount = periodCountLabel(period.topics.length, elect)

  const sidebar = (
    <div className="space-y-4">
      {elect && <ScoringCard elect={elect} />}
      {committee ? (
        <TurnoutCard
          votesCast={periodVotesCast}
          totalPower={committee.totalVotes}
          governorsVoted={governorsVoted}
          totalGovernors={committee.totalMembers}
        />
      ) : (
        <Skeleton className="h-44" />
      )}
      <div className="rounded-xl border border-border bg-card p-5">
        <Eyebrow>Period information</Eyebrow>
        <div className="mt-3.5 flex flex-col gap-3">
          <InfoRow label="Type">
            <span
              className={cn(
                'text-sm font-medium',
                isElection ? 'text-algo-blue dark:text-algo-teal' : 'text-foreground',
              )}
            >
              {isElection ? 'Election' : 'Standard vote'}
            </span>
          </InfoRow>
          {elect ? (
            <>
              {/* One election → a plain seats/candidates pair; several → a row each, so a
                  reader can see how the ballot's candidates split across the races. */}
              {elect.length === 1 ? (
                <>
                  <InfoRow label="Seats">
                    <span className="font-display text-[15px] font-bold tabular-nums">{elect[0].s}</span>
                  </InfoRow>
                  <InfoRow label={terms.Items}>
                    <span className="font-display text-[15px] font-bold tabular-nums">{groupedCount}</span>
                  </InfoRow>
                </>
              ) : (
                groups.map((g) => (
                  <InfoRow key={g.electionIndex} label={g.election.t}>
                    <span className="text-sm font-medium tabular-nums">
                      {plural(g.election.s, 'seat')} · {g.candidates.length} cand.
                    </span>
                  </InfoRow>
                ))
              )}
              {unassignedCount > 0 && (
                <InfoRow label="Unassigned">
                  <span className="text-sm font-medium tabular-nums text-warning-strong">{unassignedCount}</span>
                </InfoRow>
              )}
            </>
          ) : (
            <InfoRow label={terms.Items}>
              <span className="font-display text-[15px] font-bold tabular-nums">{period.topics.length}</span>
            </InfoRow>
          )}
          {committee && (
            <InfoRow label="Block range">
              <span className="text-sm font-medium tabular-nums">
                {formatBlockRange(committee.periodStart, committee.periodEnd)}
              </span>
            </InfoRow>
          )}
          <InfoRow label={isEnded ? 'Closed' : 'Closes'}>
            <span className="text-sm font-medium tabular-nums">{formatMonthDayYear(period.votingEnd)}</span>
          </InfoRow>
        </div>
      </div>
    </div>
  )

  const main = elect ? (
    <div className="flex flex-col gap-9">
      {groups.map((g) => (
        <section key={g.electionIndex}>
          {/* A single-election period keeps the original unheaded layout; only a
              multi-election ballot needs each race labelled. */}
          {elect.length > 1 && (
            <h2 className="mb-3.5 font-display text-lg font-bold">
              {g.election.t}
              <span className="ml-2 text-[13px] font-medium text-muted-foreground">{plural(g.election.s, 'seat')}</span>
            </h2>
          )}
          {g.candidates.length === 0 ? (
            <p className="text-muted-foreground">No candidates ran in this election.</p>
          ) : (
            <ElectionResults candidates={g.candidates.map(toCandidate)} threshold={g.election.s} live={live} />
          )}
        </section>
      ))}
      {unassignedCount > 0 && (
        <p className="text-[13px] text-warning-strong">
          {unassignedCount} candidate{unassignedCount === 1 ? '' : 's'} on this ballot{' '}
          {unassignedCount === 1 ? 'is' : 'are'} not assigned to any election, so{' '}
          {unassignedCount === 1 ? 'it' : 'they'} {unassignedCount === 1 ? 'does' : 'do'} not appear above. Their votes
          were still recorded on-chain.
        </p>
      )}
    </div>
  ) : period.topics.length === 0 ? (
    <p className="text-muted-foreground">No {terms.items} in this period.</p>
  ) : (
    <div className="flex flex-col gap-[18px]">
      {period.topics.map(([options, tallies], ti) => (
        <TopicVoteCard
          key={ti}
          topicIdx={ti}
          title={topicBodies[ti]?.title}
          options={options}
          tallies={tallies}
          mode="results"
          voters={voters?.length}
          // YOUR VOTE tag: only when the connected account's recorded vote was single-choice.
          votedOptionIdx={singleChoiceIndex(voteRecord?.topicVotes[ti])}
        />
      ))}
    </div>
  )

  return (
    <SidebarLayout sidebar={sidebar}>
      <div className="space-y-6">
        <div>
          {header}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            {isElection ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-algo-blue dark:text-algo-teal">
                <Shield className="size-3.5" />
                Election
              </span>
            ) : (
              <span>Results</span>
            )}
            <span>·</span>
            <span>Period {periodId}</span>
            <span>·</span>
            <span>{metaCount}</span>
            <span>·</span>
            <span>
              {isEnded ? 'Closed' : 'Closes'} {formatMonthDayYear(period.votingEnd)}
            </span>
          </div>
        </div>
        {main}
      </div>
    </SidebarLayout>
  )
}
