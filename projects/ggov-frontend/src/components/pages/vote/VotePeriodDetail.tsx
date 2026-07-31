import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import {
  usePeriod,
  usePeriodBody,
  useTopicBodies,
  useCanVote,
  useVoteRecord,
  useVoters,
  useAllDelegations,
  useVoteStatuses,
  useCanVoteMany,
  useVoteRecordMany,
  useCommittee,
  useGovVotingPowers,
} from '@/hooks/queries'
import { usePooledBallot, type PooledBallotPosition } from '@/hooks/fracQueries'
import { useFracVoteMutation, useVoteMutation } from '@/hooks/mutations'
import { Check, Shield } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import Address from '@/components/Address'
import AccountSelector, { AccountSelectorItem, PooledSelectorItem } from '@/components/AccountSelector'
import PooledSharePanel from '@/components/vote/PooledSharePanel'
import TopicVoteCard from '@/components/TopicVoteCard'
import ElectionCard from '@/components/ElectionCard'
import CandidateBallotCard from '@/components/CandidateBallotCard'
import ElectionStandings from '@/components/ElectionStandings'
import SidebarLayout from '@/components/SidebarLayout'
import CollectiveStatusCard from '@/components/CollectiveStatusCard'
import ConnectedWalletsEligibility from '@/components/ConnectedWalletsEligibility'
import PendingAccountsBanner, { type PendingAccount } from '@/components/PendingAccountsBanner'
import VotingRecordSection from '@/components/VotingRecordSection'
import { type AccountVoteRecordProps, type AccountVoteTopic } from '@/components/AccountVoteRecord'
import PeriodInfoCard from '@/components/PeriodInfoCard'
import BackButton from '@/components/BackButton'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import WalletPicker from '@/components/WalletPicker'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ClampedMarkdown } from '@/components/ui/clamped-markdown'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import TechnicalInfoCard from '@/components/TechnicalInfoCard'
import { groupCandidates } from 'ggov-sdk'
import { formatTimestamp, formatMonthDayYear, periodStatus, type PeriodStatus } from '@/utils/time'
import { formatApprox } from '@/utils/format'
import { periodCountLabel, periodTerms, plural } from '@/utils/periodTerms'
import { classifyOption, singleChoiceIndex, tallyBallot, type OptionSentiment } from '@/utils/vote'
import { orderByNonce } from '@/utils/ballotOrder'
import { useBallotNonce } from '@/hooks/useBallotNonce'
import { cn } from '@/lib/utils'
import { toBase64Url } from '@/hooks/queries'
import { TxButton } from '@/components/TxButtonContent'

function VoteAllocationSummary({
  allocated,
  power,
  unit = 'votes',
  approxVotes,
}: {
  allocated: number
  power: number
  /** Allocation unit — "AQ" for a pooled ballot, which is denominated in AlgoQuarters. */
  unit?: string
  /** What `allocated` is worth in gGov votes, for a pooled ballot. */
  approxVotes?: number
}) {
  const remaining = power - allocated
  const balanced = remaining === 0
  return (
    <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-dashed border-input pt-3">
      <span className="text-[12.5px] text-muted-foreground">
        <strong className="text-foreground tabular-nums">{allocated.toLocaleString()}</strong> /{' '}
        {power.toLocaleString()} {unit} allocated
        {!balanced &&
          (remaining > 0 ? ` (${remaining.toLocaleString()} remaining)` : ` (${(-remaining).toLocaleString()} over)`)}
        {approxVotes !== undefined && balanced && (
          <span className="text-teal-strong"> · ≈ {formatApprox(approxVotes)} votes</span>
        )}
      </span>
      {balanced ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-success">
          <span className="size-[7px] rounded-full bg-success" />
          Balanced
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-destructive">
          <span className="size-[7px] rounded-full bg-destructive" />
          {remaining > 0 ? 'Under' : 'Over'}
        </span>
      )}
    </div>
  )
}

/**
 * A race's own labels for the three ballot sentiments, read off a candidate's
 * on-chain options.
 *
 * Options are free-form, and every candidate in a race carries the same three, so
 * any one of them names the race's vocabulary. The fallbacks are what the Manage UI
 * writes today; a period seeded before the Veto rename reads "Against" instead, and
 * the legend and standings should say what the voter is actually choosing between.
 */
function sentimentLabels(options: string[] | undefined) {
  const find = (s: OptionSentiment) => options?.find((o) => classifyOption(o) === s)
  return { yes: find('yes') ?? 'Support', no: find('no') ?? 'Veto', abstain: find('abstain') ?? 'Abstain' }
}

/**
 * Project pooled positions onto the selector's row shape. `viaAddress` is set only
 * for a delegator's pools, which is what makes those rows read "<account>'s share"
 * and nest a level deeper.
 */
function pooledSelectorItems(positions: PooledBallotPosition[] | undefined, viaAddress?: string): PooledSelectorItem[] {
  return (positions ?? []).map((p) => ({
    id: p.id,
    instanceName: p.instanceName,
    sharePct: p.sharePct,
    votes: p.votes,
    viaAddress,
    canVote: p.canVote,
    hasVoted: p.hasVoted,
    votedDirectly: p.votedDirectly,
    poolNotReady: p.poolNotReady,
  }))
}

/**
 * Tense-adjusted eligibility wording for the connected voter. `self` is the full
 * sentence when voting for yourself; `suffix` follows an `<Address>` when voting
 * for someone else; `muted` styles it as secondary rather than emphasised. `self`
 * is omitted for the active/ineligible case — there the UI names the account
 * inline (`<Address> is not eligible…`) instead of a generic "You…" sentence.
 */
function eligibilityCopy(status: PeriodStatus, canVote: boolean): { self?: string; suffix: string; muted: boolean } {
  if (canVote) {
    if (status === 'active') return { self: 'You are eligible to vote', suffix: 'is eligible to vote', muted: false }
    if (status === 'upcoming')
      return {
        self: "You'll be eligible to vote when voting opens",
        suffix: 'will be eligible to vote when voting opens',
        muted: false,
      }
    return {
      self: 'Voting has closed — you did not vote in this period',
      suffix: 'did not vote in this period',
      muted: true,
    }
  }
  if (status === 'active') return { suffix: 'cannot vote in this period', muted: true }
  if (status === 'upcoming')
    return {
      self: 'You are not eligible to vote in this period',
      suffix: 'is not eligible to vote in this period',
      muted: true,
    }
  return {
    self: 'You were not eligible to vote in this period',
    suffix: 'were not eligible to vote in this period',
    muted: true,
  }
}

export default function VotePeriodDetail() {
  const { periodId: pidParam } = useParams({ strict: false })
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()
  const { activeAddress, activeWallet, activeWalletAccounts } = useWallet()
  const walletAddresses = (activeWalletAccounts ?? []).map((a) => a.address)

  // What the ballot is being cast for: an account (yourself, or one that delegated
  // to you) identified by address, or a pooled position identified by its
  // `{instanceNumId}:{owner}` id. The two share one namespace because they share
  // one radio group — see `AccountSelector`.
  const [selectedVoter, setSelectedVoter] = useState<string | null>(activeAddress ?? null)
  // When we switch the active account in order to vote as one of its delegators,
  // remember that delegator so the reset-on-switch below keeps it selected.
  const pendingVoterRef = useRef<string | null>(null)
  // The "Voting as" account-context card, so "Switch & vote" can scroll back to it.
  const votingAsRef = useRef<HTMLDivElement>(null)
  // Set when a vote was just cast, so the post-vote banner scrolls itself into
  // view on the render where it first appears (but not on an initial page load
  // that already has a vote record).
  const justVotedRef = useRef(false)
  const bannerRef = useCallback((el: HTMLDivElement | null) => {
    if (el && justVotedRef.current) {
      justVotedRef.current = false
      // `nearest` only scrolls when the banner isn't already visible.
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [])
  useEffect(() => {
    if (pendingVoterRef.current) {
      setSelectedVoter(pendingVoterRef.current)
      pendingVoterRef.current = null
    } else {
      setSelectedVoter(activeAddress ?? null)
    }
  }, [activeAddress])

  const { data: period, isLoading } = usePeriod(periodId)
  const { data: periodBody } = usePeriodBody(periodId)
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0)
  // Seeds this browser's own candidate order (see `orderByNonce`). Null until mounted.
  const ballotNonce = useBallotNonce()
  // The period's committee drives the eligible-governor count and the
  // window-independent voting power used for non-active display.
  const committeeIdB64 = period ? toBase64Url(period.committeeId) : undefined
  const { data: committee } = useCommittee(committeeIdB64)

  // Group every delegation that targets one of the wallet's accounts, so each
  // account shows its delegated accounts up front — no need to switch to it.
  const { data: allDelegations } = useAllDelegations()
  const walletAddressSet = new Set(walletAddresses)
  const delegatorsByDelegatee: Record<string, string[]> = {}
  const delegateeOf: Record<string, string> = {}
  if (allDelegations) {
    for (const [delegator, delegatee] of allDelegations) {
      if (!walletAddressSet.has(delegatee)) continue
      ;(delegatorsByDelegatee[delegatee] ??= []).push(delegator)
      delegateeOf[delegator] = delegatee
    }
  }
  const allDelegators = Object.keys(delegateeOf)
  // Delegators of the currently active account (for the self-power fallback below).
  const delegators = delegatorsByDelegatee[activeAddress ?? ''] ?? []

  // Vote status for every selectable account, to badge those that haven't voted yet.
  const voterAccounts = Array.from(new Set([...walletAddresses, ...allDelegators]))
  const voteStatuses = useVoteStatuses(periodId, voterAccounts)
  // Window-independent voting power per account (the registry doesn't gate on the
  // voting window, unlike canVote), so the sidebar shows real standing in
  // upcoming/ended periods too.
  const govPowers = useGovVotingPowers(committeeIdB64, voterAccounts)
  // Vote records for every account the wallet can act for. `isDelegated` tells us
  // when a delegator voted directly (a state the delegatee cannot override), and
  // the records drive the ended-period multi-account voting-record section.
  const allRecords = useVoteRecordMany(periodId, voterAccounts)
  // Distinct accounts that voted in the period (one vote-record box each) — the
  // "{N} voters" figure on the ended-period results cards.
  const { data: voters } = useVoters(periodId)
  // Eligibility + voting power. Own wallet accounts vote as themselves (sender =
  // voter); each delegator is checked against the account it delegated to.
  const walletEligibility = useCanVoteMany(periodId, walletAddresses)
  const delegatorEligibility = useCanVoteMany(periodId, allDelegators, delegateeOf)
  // Recomputed here rather than reusing the `status` below, which is derived after
  // this component's early returns — and hooks must run unconditionally. Pure and
  // cheap, so the duplicate costs nothing.
  const isActivePeriod = period ? periodStatus(period.votingStart, period.votingEnd) === 'active' : false

  // Who signs for whom: an own account signs for itself, a delegator's ballot is
  // signed by the account it delegated to. This is what lets a pooled position
  // held by a delegator be cast at all — the frac contract honours the same gGov
  // delegation as a direct vote.
  //
  // Wallet accounts are applied last, so an account that is *both* in the wallet
  // and a delegator to another wallet account signs for itself. Going through the
  // delegation instead would be needlessly strict: a delegated cast is blocked once
  // the owner has voted directly, and it forces a signer switch for no gain.
  const senderOf: Record<string, string> = {}
  for (const [delegator, delegatee] of Object.entries(delegateeOf)) senderOf[delegator] = delegatee
  for (const addr of walletAddresses) senderOf[addr] = addr

  // Staking-pool positions this wallet can act on for the period's committee.
  // Empty (and free — no reads) on a network with no frac registry.
  const pooled = usePooledBallot({
    periodId,
    committeeIdBase64Url: committeeIdB64,
    voters: voterAccounts,
    senderOf,
    isActive: isActivePeriod,
  })
  const pooledByOwner: Record<string, PooledBallotPosition[]> = {}
  for (const position of pooled.positions) (pooledByOwner[position.owner] ??= []).push(position)
  // The current selection, when it's a pooled position rather than an account.
  const selectedPooled = selectedVoter ? pooled.byId[selectedVoter] : undefined

  // For delegated voting, the connected wallet (activeAddress) is the sender; selectedVoter is the voter.
  // A pooled selection has its own eligibility (`position.canVote`), so the gGov
  // check is skipped — its id is not an address and would fail the lookup.
  const { data: canVoteResult } = useCanVote(periodId, selectedPooled ? null : selectedVoter, activeAddress)
  // Whether the connected wallet has voting power of its own; if not, hide the "Yourself" option.
  const { data: selfCanVoteResult } = useCanVote(periodId, activeAddress, activeAddress)
  const selfCanVote = (selfCanVoteResult?.votingPower ?? 0n) > 0n
  const { data: voteRecord } = useVoteRecord(periodId, selectedPooled ? null : selectedVoter)
  const voteMutation = useVoteMutation()
  const fracVoteMutation = useFracVoteMutation()

  // If the connected wallet has no voting power of its own, fall back to the first
  // selectable delegator so we never leave the (now hidden) "Yourself" option selected.
  // Skips delegators with 0 voting power, which AccountSelector hides.
  const firstSelectableDelegator = delegators.find((addr) => {
    const eligibility = delegatorEligibility[addr]
    return eligibility?.canVote === true && eligibility.votingPower > 0n
  })
  // Failing that, an eligible pooled position: an account whose only power is
  // pooled (no blocks produced, nothing delegated to it) would otherwise sit on a
  // dimmed, unselectable "Yourself" row with no way to reach its own pools.
  const firstSelectablePooled = pooled.positions.find((p) => p.canVote === true)?.id
  const selectionFallback = firstSelectableDelegator ?? firstSelectablePooled
  useEffect(() => {
    if (selfCanVoteResult && !selfCanVote && selectedVoter === activeAddress && selectionFallback !== undefined) {
      setSelectedVoter(selectionFallback)
    }
  }, [selfCanVoteResult, selfCanVote, selectedVoter, activeAddress, selectionFallback])

  const votingForSelf = !selectedPooled && selectedVoter === activeAddress

  // Logged-out "connect a wallet to vote" CTA on active periods opens the picker.
  const [connectOpen, setConnectOpen] = useState(false)
  const [advancedMode, setAdvancedMode] = useState(false)
  // Simple mode: selected option index per topic (-1 = none selected)
  const [simpleSelections, setSimpleSelections] = useState<number[]>([])
  // Advanced mode: manual vote allocation
  const [topicVotes, setTopicVotes] = useState<number[][][]>([])

  // Seed ballot state once per period. Keying on periodId (not the `period`
  // object identity) stops a background refetch — e.g. on window refocus — from
  // wiping the voter's in-progress selections.
  const seededBallotPeriodId = useRef<number | null>(null)
  useEffect(() => {
    if (period && seededBallotPeriodId.current !== periodId) {
      seededBallotPeriodId.current = periodId
      setSimpleSelections(period.topics.map(() => -1))
      setTopicVotes(period.topics.map(([options]) => [options.map(() => 0)]))
    }
  }, [period, periodId])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!period) {
    return <p className="text-muted-foreground">Period not found.</p>
  }

  const status = periodStatus(period.votingStart, period.votingEnd)
  const isActive = status === 'active'
  const isUpcoming = status === 'upcoming'
  const isEnded = status === 'ended'
  // Elections (period body carries `elect`) expose their live
  // ranked standings while active; any ended period exposes its full results.
  const elect = periodBody?.elect
  const terms = periodTerms(elect)
  const isElection = terms.isElection
  const showVoteForm = isActive && (selectedPooled ? selectedPooled.canVote : canVoteResult?.canVote) && sdk
  const votingPower = canVoteResult?.votingPower ?? 0n
  // A pooled ballot is denominated in AlgoQuarters, not gGov votes: each topic must
  // allocate the position's full AQ weight, and the pool converts that to votes when
  // it re-casts through its escrows. Only the unit label differs — the allocation
  // rule ("every topic totals your weight") is the same one the gGov ballot uses.
  const ballotUnit = selectedPooled ? 'AQ' : 'votes'
  // Votes per AQ for this position, for the approximate equivalents alongside AQ figures.
  const votesPerAq = selectedPooled ? selectedPooled.poolVotes / selectedPooled.totalAq : 0

  // Selecting one of the wallet's own accounts switches the active (signing)
  // account — the activeAddress effect then points selectedVoter at it.
  // Selecting a delegator votes on its behalf; its delegatee must be the active
  // (signing) account, so switch to that delegatee first if needed.
  function handleSelectVoter(addr: string) {
    // A pooled position: whoever signs for its owner must be the active account,
    // same rule as a delegated vote — so switch the signer first if it differs.
    const position = pooled.byId[addr]
    if (position) {
      if (position.sender !== activeAddress && activeWallet) {
        pendingVoterRef.current = addr
        activeWallet.setActiveAccount(position.sender)
      } else {
        setSelectedVoter(addr)
      }
      return
    }
    if (walletAddresses.includes(addr)) {
      if (addr !== activeAddress) activeWallet?.setActiveAccount(addr)
      setSelectedVoter(addr)
      return
    }
    const delegatee = delegateeOf[addr]
    if (delegatee && delegatee !== activeAddress && activeWallet) {
      // Stash the delegator only once we know the signer switch will run, so a
      // no-op setActiveAccount can't leave a stale ref to apply on a later switch.
      pendingVoterRef.current = addr
      activeWallet.setActiveAccount(delegatee)
    } else {
      setSelectedVoter(addr)
    }
  }

  function handleSimpleSelect(topicIdx: number, optionIdx: number) {
    setSimpleSelections((prev) => {
      const next = [...prev]
      next[topicIdx] = prev[topicIdx] === optionIdx ? -1 : optionIdx
      return next
    })
  }

  function handleAdvancedVoteChange(topicIdx: number, optionIdx: number, value: number) {
    // Votes are non-negative integers; clamp here so fractional/negative/NaN input
    // can't propagate into the on-chain uint32[][] payload.
    const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    setTopicVotes((prev) => {
      const next = prev.map((t) => t.map((opts) => [...opts]))
      next[topicIdx][0][optionIdx] = safe
      return next
    })
  }

  function buildVotes(): number[][] {
    if (advancedMode) {
      return topicVotes.map((t) => t[0])
    }
    // Simple mode: all of the selection's weight to the chosen option. For a pooled
    // position that weight is its AlgoQuarters, not gGov votes.
    const weight = selectedPooled ? Number(selectedPooled.aqWeight ?? 0n) : Number(votingPower)
    return period!.topics.map(([options], topicIdx) => {
      const selected = simpleSelections[topicIdx]
      return options.map((_, optIdx) => (optIdx === selected ? weight : 0))
    })
  }

  function submitVote() {
    if (!selectedVoter) return
    const onSuccess = () => {
      // Return to simple mode once an advanced-mode vote lands, and arm the
      // post-vote banner to scroll into view when it next renders.
      setAdvancedMode(false)
      justVotedRef.current = true
    }
    if (selectedPooled) {
      fracVoteMutation.mutate(
        {
          instanceNumId: selectedPooled.instanceNumId,
          periodId,
          voterAccount: selectedPooled.owner,
          topicVotes: buildVotes(),
        },
        { onSuccess },
      )
      return
    }
    voteMutation.mutate({ periodId, voterAccount: selectedVoter, topicVotes: buildVotes() }, { onSuccess })
  }

  const canSubmitSimple = simpleSelections.length > 0 && simpleSelections.every((s) => s >= 0)
  // The weight every topic must allocate — AlgoQuarters for a pooled selection.
  const power = selectedPooled ? Number(selectedPooled.aqWeight ?? 0n) : Number(votingPower)
  const advancedTopicTotals = topicVotes.map((t) => t[0]?.reduce((a, b) => a + b, 0) ?? 0)
  const advancedValid = advancedTopicTotals.length > 0 && advancedTopicTotals.every((t) => t === power)
  const canSubmit = advancedMode ? advancedValid : canSubmitSimple

  // Aggregate standing across every account the wallet can act for (its own
  // accounts plus any delegators), shown in the Collective Status sidebar card.
  // Uses registry voting power so it's correct in non-active periods too.
  let collectiveVotingPower = 0n
  let collectiveEligible = 0
  let collectiveVoted = 0
  for (const addr of voterAccounts) {
    const vp = govPowers[addr] ?? 0
    if (vp > 0) {
      collectiveVotingPower += BigInt(vp)
      collectiveEligible++
      if (voteStatuses[addr]) collectiveVoted++
    }
  }
  // `govPowers` is `undefined` per account until its query settles. Treating that
  // as 0 would briefly render the card's "Not eligible to vote" state before the
  // powers load, so hold the card back until every voter account has resolved.
  const collectiveStatusReady = voterAccounts.every((addr) => govPowers[addr] !== undefined)

  // Per-wallet eligibility for the non-active expandable list. Outside the voting
  // window eligibility is registry voting power (canVote is false for everyone),
  // and an account is "delegated" when it isn't one of the wallet's own accounts.
  const walletEligibilityItems = voterAccounts.map((addr) => ({
    address: addr,
    votingPower: govPowers[addr] ?? 0,
    eligible: (govPowers[addr] ?? 0) > 0,
    voted: !!voteStatuses[addr],
    delegated: !walletAddresses.includes(addr),
  }))

  // Eligibility wording: during the active window canVote is authoritative (it
  // also reflects delegation/override rules); outside it canVote returns false
  // for everyone, so fall back to registry voting power.
  // A pooled id is not an address, so it has no entry here — its weight comes off
  // the position itself.
  const selectedVoterPower = selectedVoter && !selectedPooled ? (govPowers[selectedVoter] ?? 0) : 0
  const eligibleToVote = isActive ? !!canVoteResult?.canVote : selectedVoterPower > 0
  const eligibility = !selectedPooled && canVoteResult ? eligibilityCopy(status, eligibleToVote) : null

  // Total voting power exercised in the period. A voter spreads their full power
  // across each topic, so any topic's tally sum reflects total participation; we
  // take the max so a not-yet-tallied topic doesn't understate it.
  const periodVotesCast = period.topics.reduce(
    (max, [, tallies]) =>
      Math.max(
        max,
        tallies.reduce((a, b) => a + b, 0),
      ),
    0,
  )

  // The committee's member count is the number of eligible governors.
  const eligibleGovernors = committee?.totalMembers

  // Ended-period multi-account voting record: for each account the wallet can act
  // for that cast a vote, its final per-topic allocations. A voter re-spends its
  // full power in every topic, so the per-account total is a topic's allocation
  // sum (max over topics, mirroring `periodVotesCast`), not a sum across topics.
  const accountRecords: AccountVoteRecordProps[] = isEnded
    ? voterAccounts
        .map((addr): AccountVoteRecordProps | null => {
          const rec = allRecords[addr]
          if (!rec || !rec.topicVotes) return null
          const role: AccountVoteRecordProps['role'] = walletAddresses.includes(addr)
            ? 'self'
            : rec.isDelegated
              ? 'delegated'
              : 'direct'
          let total = 0
          const topics = period.topics
            .map(([options], ti): AccountVoteTopic | null => {
              const votes = rec.topicVotes[ti] ?? []
              const topicSum = votes.reduce((a, b) => a + b, 0)
              if (topicSum === 0) return null
              total = Math.max(total, topicSum)
              const allocations = votes
                .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, votes: v }))
                .filter((a) => a.votes > 0)
                .map((a) => ({ ...a, pct: Math.round((a.votes / topicSum) * 100) }))
              return { index: ti, title: topicBodies[ti]?.title, split: allocations.length > 1, allocations }
            })
            .filter((t): t is AccountVoteTopic => t !== null)
          if (topics.length === 0) return null
          return { address: addr, role, total, topics }
        })
        .filter((r): r is AccountVoteRecordProps => r !== null)
    : []

  // Post-vote nudge: once the selected voter has voted, surface the wallet's
  // *other* controlled accounts that are eligible and still haven't voted.
  const pendingAccounts: PendingAccount[] = voterAccounts
    .filter((addr) => addr !== selectedVoter && !voteStatuses[addr])
    .filter((addr) => {
      const elig = walletAddresses.includes(addr) ? walletEligibility[addr] : delegatorEligibility[addr]
      return !!elig?.canVote
    })
    .map((addr) => ({
      address: addr,
      votingPower: govPowers[addr] ?? 0,
      delegated: !walletAddresses.includes(addr),
    }))
  // Accounts only — the banner names an address and its gGov power, neither of
  // which a pooled position has. (The design's post-vote banners carry no pooled
  // content either.)
  const showPendingBanner = isActive && !selectedPooled && !!voteRecord && !!selectedVoter && pendingAccounts.length > 0

  function switchAndVote(addr: string) {
    handleSelectVoter(addr)
    votingAsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // One-line hint beside the submit button: what's still missing, else the
  // change-your-vote deadline once a ballot is valid.
  const missingSeats = simpleSelections.filter((s) => s < 0).length
  // A pooled selection has its own record (`hasVoted`); `voteRecord` is the gGov one.
  const selectionHasVoted = selectedPooled ? selectedPooled.hasVoted : !!voteRecord
  const submitHint = !canSubmit
    ? advancedMode
      ? `Allocate exactly ${power.toLocaleString()} ${ballotUnit} in every ${terms.item}`
      : `${missingSeats} of ${plural(period.topics.length, terms.item)} still need a choice`
    : selectionHasVoted
      ? `You can change your vote until ${formatTimestamp(period.votingEnd)}`
      : ''

  // Which race each candidate runs in. Presentation only — the ballot state and
  // the `vote()` payload stay flat and indexed by the on-chain topic index, which
  // is what `GroupedCandidate.topicIndex` carries.
  //
  // Within a race the candidates are then reordered per browser so no one is
  // permanently top of the ballot; each race scopes its own permutation, so two
  // races on one ballot don't shuffle in lockstep.
  const groups = (elect ? groupCandidates(period.topics, topicBodies, elect) : []).map((g) => ({
    ...g,
    candidates: orderByNonce(g.candidates, ballotNonce, `${periodId}:e${g.electionIndex}`, (c) => c.topicIndex),
  }))
  const groupedIdx = new Set(groups.flatMap((g) => g.candidates.map((c) => c.topicIndex)))
  // `groupCandidates` drops candidates whose `e` tag is missing or names no
  // declared election. They still have to appear on the ballot: the contract
  // requires *every* topic row to allocate the voter's full power, so leaving one
  // out would make the period unvotable. (The operator sees them flagged in
  // /manage; a voter just needs to be able to vote on them.)
  const ungroupedIdx = orderByNonce(
    period.topics.map((_, i) => i).filter((i) => !groupedIdx.has(i)),
    // Standard periods list topics in the operator's authored order; only an
    // election's candidates get shuffled.
    isElection ? ballotNonce : null,
    `${periodId}:unassigned`,
    (i) => i,
  )

  /**
   * One ballot card, addressed by its **on-chain topic index** — the same index the
   * ballot state arrays and `buildVotes()` use. Grouping only changes the order the
   * cards are emitted in, never how they are keyed.
   */
  function renderBallotItem(topicIdx: number) {
    const [options, tallies] = period!.topics[topicIdx]
    const tb = topicBodies[topicIdx]
    const mode = isUpcoming ? 'upcoming' : showVoteForm ? (advancedMode ? 'advanced' : 'select') : 'results'
    // Tag an option "YOUR VOTE" only when the recorded vote was single-choice
    // (exactly one non-zero option). Split/advanced votes get no tag rather than
    // misleadingly highlighting just the largest allocation.
    const votedOptionIdx = mode === 'results' ? singleChoiceIndex(voteRecord?.topicVotes[topicIdx]) : undefined
    // A candidate is scored, not chosen between, so the simple ballot gives each one
    // sentiment chips instead of a radio list of "options". Applies to every candidate
    // on an election ballot, including the ones no declared race claimed.
    if (isElection && mode === 'select') {
      return (
        <CandidateBallotCard
          key={topicIdx}
          name={tb?.title ?? `Candidate ${topicIdx + 1}`}
          statement={tb?.body}
          options={options}
          selectedOption={simpleSelections[topicIdx] ?? -1}
          onSelect={(optIdx) => handleSimpleSelect(topicIdx, optIdx)}
        />
      )
    }
    return (
      <TopicVoteCard
        key={topicIdx}
        topicIdx={topicIdx}
        // A candidate is identified by name and, in the results, by rank — the
        // ordinal chip would number straight through races that are ranked apart.
        showIndex={!isElection}
        title={tb?.title}
        body={tb?.body}
        options={options}
        tallies={tallies}
        mode={mode}
        selectedOption={mode === 'select' ? (simpleSelections[topicIdx] ?? -1) : -1}
        onSelect={(optIdx) => handleSimpleSelect(topicIdx, optIdx)}
        advancedVotes={topicVotes[topicIdx]?.[0]}
        onAdvancedChange={(optIdx, value) => handleAdvancedVoteChange(topicIdx, optIdx, value)}
        votingPower={power}
        unit={ballotUnit}
        // Consumed in `select` mode only: a pooled simple ballot labels the
        // chosen option with what the whole position is worth in votes.
        approxVotes={selectedPooled ? selectedPooled.votes : undefined}
        votedOptionIdx={votedOptionIdx}
        outcome={isEnded ? 'Final' : undefined}
        voters={voters?.length}
        footer={
          showVoteForm && advancedMode ? (
            <VoteAllocationSummary
              allocated={advancedTopicTotals[topicIdx]}
              power={power}
              unit={ballotUnit}
              approxVotes={selectedPooled ? advancedTopicTotals[topicIdx] * votesPerAq : undefined}
            />
          ) : undefined
        }
      />
    )
  }

  /**
   * One race on an election ballot: the {@link ElectionCard} shell around whichever
   * view the current state calls for.
   *
   * - scoring (active, eligible, simple) → a {@link CandidateBallotCard} per candidate
   * - advanced → the plain {@link TopicVoteCard} allocation inputs, which elections
   *   still support: the contract wants every topic row to spend the voter's full
   *   power, and splitting it across Support/Veto/Abstain is a legitimate way to do
   *   that. The scoring chips are single-choice by construction, so they can't
   *   express it.
   * - otherwise → read-only {@link ElectionStandings}, or the bare option list before
   *   voting opens and there is nothing to rank.
   */
  function renderElection(g: (typeof groups)[number]) {
    const scoring = showVoteForm && !advancedMode
    const labels = sentimentLabels(g.candidates[0]?.options)
    const body = (() => {
      if (g.candidates.length === 0) {
        return <p className="px-[18px] py-5 text-muted-foreground">No candidates are standing in this election.</p>
      }
      if (showVoteForm || isUpcoming) {
        return (
          <div className={cn('px-[18px] py-3.5', scoring ? 'space-y-2.5' : 'space-y-4')}>
            {g.candidates.map((c) => renderBallotItem(c.topicIndex))}
          </div>
        )
      }
      return (
        <ElectionStandings
          seats={g.election.s}
          labels={labels}
          candidates={g.candidates.map((c) => {
            const { yes, no, abstain } = tallyBallot(c.options, c.tallies)
            return {
              name: c.name ?? `Candidate ${c.topicIndex + 1}`,
              support: yes,
              veto: no,
              abstain,
            }
          })}
        />
      )
    })()

    return (
      <ElectionCard
        key={g.electionIndex}
        electionIndex={g.electionIndex}
        title={g.election.t}
        seats={g.election.s}
        candidateCount={g.candidates.length}
        scoring={
          scoring
            ? {
                scored: g.candidates.filter((c) => (simpleSelections[c.topicIndex] ?? -1) >= 0).length,
                options: g.candidates[0]?.options ?? [],
              }
            : undefined
        }
        note={
          !scoring && !showVoteForm && !isUpcoming && g.candidates.length > 0 ? (
            <>
              Top {g.election.s} by net score ({labels.yes} − {labels.no}) take the seats.{' '}
              {isEnded ? 'Final tallies recorded on-chain.' : 'Standings are provisional until voting closes.'}
            </>
          ) : undefined
        }
      >
        {body}
      </ElectionCard>
    )
  }

  const mainContent = (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <BackButton to="/vote" />
          <h1 className="text-2xl font-bold">{periodBody?.title}</h1>
          <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
          <span>Period {periodId}</span>
          <span>·</span>
          <span>{periodCountLabel(period.topics.length, elect)}</span>
          <span>·</span>
          <span>
            {isUpcoming ? 'Opens' : isActive ? 'Closes' : 'Closed'}{' '}
            {formatMonthDayYear(isUpcoming ? period.votingStart : period.votingEnd)}
          </span>
        </div>
      </div>

      {periodBody?.body && <ClampedMarkdown lines={9}>{periodBody.body}</ClampedMarkdown>}

      {isActive && !activeAddress && (
        <Callout variant="info" title="Connect a wallet to vote">
          <p>Connect your Algorand wallet to cast your vote in this period.</p>
          <Button className="mt-3" onClick={() => setConnectOpen(true)}>
            Connect wallet
          </Button>
        </Callout>
      )}

      {isActive && activeAddress && voterAccounts.length >= 1 && (
        <div className="space-y-2.5">
          <div ref={votingAsRef} className="scroll-mt-6 rounded-xl border border-border bg-card px-5 py-[18px]">
            <AccountSelector
              selected={selectedVoter}
              onSelect={handleSelectVoter}
              connectedCount={walletAddresses.length}
              delegatedCount={allDelegators.length}
              pooledCount={pooled.positions.length}
              accounts={walletAddresses.map<AccountSelectorItem>((addr) => ({
                address: addr,
                votingPower: walletEligibility[addr]?.votingPower,
                canVote: walletEligibility[addr]?.canVote,
                hasVoted: voteStatuses[addr],
                pooled: pooledSelectorItems(pooledByOwner[addr]),
                // Accounts that delegated to this one nest under it as children.
                delegated: (delegatorsByDelegatee[addr] ?? []).map<AccountSelectorItem>((d) => {
                  const record = allRecords[d]
                  return {
                    address: d,
                    votingPower: delegatorEligibility[d]?.votingPower,
                    canVote: delegatorEligibility[d]?.canVote,
                    hasVoted: voteStatuses[d],
                    // Voted for itself (not via a delegate) → the delegate can't override.
                    votedDirectly: record != null && record.topicVotes != null && !record.isDelegated,
                    // A delegator's own pools, which this wallet can cast on its behalf.
                    // Skipped when the delegator is itself one of the wallet's accounts:
                    // it already has a top-level row carrying the same positions, and a
                    // second copy would share their ids and highlight in two places.
                    pooled: walletAddresses.includes(d) ? undefined : pooledSelectorItems(pooledByOwner[d], d),
                  }
                }),
              }))}
            />

            {/* Pooled counterpart of the eligibility sentence below: names the pool
              rather than an address, since a position has no address of its own. */}
            {selectedPooled && selectedPooled.canVote !== undefined && (
              <div className="mt-4 flex items-start gap-2.5 text-[13.5px] leading-relaxed">
                {selectedPooled.canVote && (
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-success text-white">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                )}
                <span className={selectedPooled.canVote ? 'text-foreground' : 'text-muted-foreground'}>
                  {selectedPooled.canVote ? (
                    <>
                      {/* Share-of-the-pool framing, not AlgoQuarters: the member's own
                        AQ number means nothing without the pool's total, whereas the
                        percentage and the votes it buys are directly meaningful. AQ
                        belongs to the advanced ballot, which allocates in that unit. */}
                      You're voting with <strong>{selectedPooled.sharePct.toFixed(2)}%</strong> of{' '}
                      <strong>{selectedPooled.instanceName}</strong>'s ballot, about{' '}
                      <strong>{formatApprox(selectedPooled.votes)} votes</strong>
                      {selectedPooled.ownerIsSelf ? (
                        ''
                      ) : (
                        <>
                          {' '}
                          on behalf of <Address address={selectedPooled.owner} width={6} copy={false} tooltip={false} />
                        </>
                      )}
                      .
                      {/* Own line: it's a separate fact about the ballot, not part of
                          the weight sentence. (The span's parent is a flex item, so
                          `block` here breaks the line cleanly.) */}
                      {selectionHasVoted && (
                        <span className="mt-1 block">
                          You can change it any time until voting closes on {formatTimestamp(period.votingEnd)}.
                        </span>
                      )}
                    </>
                  ) : selectedPooled.poolNotReady ? (
                    <>
                      <strong>{selectedPooled.instanceName}</strong> hasn't finished preparing for this period yet — its
                      snapshot or AlgoQuarters ledger is still being published. Your share is unaffected; check back
                      before voting closes.
                    </>
                  ) : (
                    <>
                      <Address address={selectedPooled.owner} width={6} copy={false} tooltip={false} /> already cast
                      this pool's vote directly, so you cannot override it.
                    </>
                  )}
                </span>
              </div>
            )}

            {(voteRecord || eligibility) && (
              <div className="mt-4 flex items-start gap-2.5 text-[13.5px] leading-relaxed">
                {(voteRecord || !eligibility!.muted) && (
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-success text-white">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                )}
                <span className={voteRecord || !eligibility!.muted ? 'text-foreground' : 'text-muted-foreground'}>
                  {voteRecord ? (
                    <>
                      You can change your vote any time until voting closes on{' '}
                      <strong>{formatTimestamp(period.votingEnd)}</strong>.
                    </>
                  ) : votingForSelf ? (
                    // Name the active account explicitly when it can't vote, rather than
                    // the generic "You cannot vote in this period". (This block is
                    // active-only, so ineligible here means !canVote in the open window.)
                    eligibleToVote ? (
                      eligibility!.self
                    ) : (
                      <>
                        <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> is not eligible to
                        vote in this period
                      </>
                    )
                  ) : (
                    <>
                      <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> {eligibility!.suffix}
                    </>
                  )}
                </span>
              </div>
            )}

            {!votingForSelf && voteRecord && !voteRecord.isDelegated && (
              <Callout variant="danger" className="mt-2.5">
                <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> has already voted directly,
                so you cannot vote on their behalf. A delegate cannot override a vote the account holder cast
                themselves.
              </Callout>
            )}
          </div>

          {/* Below the card rather than inside it: the note explains what the pooled
              rows are in general, so keeping it out of the card stops it reading as
              context for the current selection. */}
          {pooled.positions.length > 0 && (
            <Callout variant="pooled">
              Pooled positions vote your prorated share of the pool's power. Members' votes are combined and cast
              on-chain by the pool.
            </Callout>
          )}
        </div>
      )}

      {/* What's being elected, and the way through to the standings. Active
          elections expose their live ranked order; ended ones their final
          result — so one strip serves both, rather than the two near-identical
          blocks (one right-aligned, one not) this replaces. */}
      {isElection && elect && (isActive || isEnded) && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/40 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-algo-blue dark:text-algo-teal">
              <Shield className="size-3.5" />
              {elect.length > 1 ? plural(elect.length, 'election') : 'Election'}
            </span>
            {elect.map((e, i) => (
              <span key={i} className="flex items-center gap-2.5 text-muted-foreground">
                {i > 0 && <span aria-hidden>·</span>}
                <span>
                  {/* One race needs no name here — the period title already is it. */}
                  {elect.length > 1 && <span className="text-foreground">{e.t} </span>}
                  {plural(e.s, 'seat')}
                </span>
              </span>
            ))}
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 self-start sm:self-auto">
            <Link to="/vote/period/$periodId/results" params={{ periodId: String(periodId) }}>
              {isActive ? 'View live standings' : 'View ranked results'}
            </Link>
          </Button>
        </div>
      )}

      {activeAddress && isUpcoming && voterAccounts.length > 0 && collectiveStatusReady && (
        <ConnectedWalletsEligibility items={walletEligibilityItems} eligibleCount={collectiveEligible} />
      )}

      {isEnded && activeAddress && accountRecords.length > 0 && (
        <VotingRecordSection
          activeAddress={activeAddress}
          records={accountRecords}
          topicCount={period.topics.length}
          topicNoun={terms.item}
        />
      )}

      <Separator />

      <div>
        <div className="flex items-center justify-between gap-3">
          {/* Each election card carries its own name and seat count, so the section
              heading names what the ballot is rather than repeating "Candidates". */}
          <h2 className="text-xl font-semibold">{isElection ? 'Elections' : terms.Items}</h2>
          {showVoteForm && (
            <div className="flex shrink-0 items-center gap-2.5">
              {/* Dropped on narrow screens: "Candidates" leaves the row too tight for
                  it, and the two tabs already read as a mode switch without it. */}
              <span className="hidden text-[12.5px] text-muted-foreground sm:inline">Ballot mode</span>
              <Tabs
                value={advancedMode ? 'advanced' : 'simple'}
                onValueChange={(v) => setAdvancedMode(v === 'advanced')}
              >
                <TabsList className="h-8">
                  <TabsTrigger value="simple" className="px-3 text-xs">
                    Simple
                  </TabsTrigger>
                  <TabsTrigger value="advanced" className="px-3 text-xs">
                    Advanced
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}
        </div>
        {showVoteForm && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            {selectedPooled ? (
              advancedMode ? (
                // The only ballot that exposes AlgoQuarters, so the only one that
                // links out to what they are and how the pool converts them.
                <>
                  Split your AlgoQuarters across the options as you like — each {terms.item} must use your full weight.
                  The pool converts your AlgoQuarters to votes when it casts.{' '}
                  <Link
                    to="/docs/pooled-voting"
                    className="inline-flex items-center font-semibold text-primary hover:underline dark:text-algo-teal"
                  >
                    How pooled voting works
                  </Link>
                </>
              ) : (
                `Pick one option per ${terms.item}; your whole pooled share goes to that choice.`
              )
            ) : advancedMode ? (
              `Split your votes across the options as you like — each ${terms.item} must use your full voting power.`
            ) : (
              `Pick one option per ${terms.item}; all of your votes go to that choice.`
            )}
          </p>
        )}
      </div>

      {period.topics.length === 0 ? (
        <p className="text-muted-foreground">No {terms.items} in this period.</p>
      ) : isElection ? (
        // Each race gets its own card, in `elect` order, so a voter can tell which
        // seats a candidate is standing for — a candidate is only ever ranked
        // against the others in its own race.
        <div className="flex flex-col gap-[18px]">
          {groups.map((g) => renderElection(g))}
          {ungroupedIdx.length > 0 && (
            <section>
              <h3 className="mb-3.5 font-display text-lg font-bold">Other candidates</h3>
              <div className={cn(showVoteForm && !advancedMode ? 'space-y-2.5' : 'space-y-4')}>
                {ungroupedIdx.map(renderBallotItem)}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="space-y-4">{period.topics.map((_, topicIdx) => renderBallotItem(topicIdx))}</div>
      )}

      {showVoteForm && (
        <div className="flex items-center gap-4">
          <TxButton
            onClick={submitVote}
            disabled={!canSubmit}
            pending={selectedPooled ? fracVoteMutation.isPending : voteMutation.isPending}
            success={selectedPooled ? fracVoteMutation.isSuccess : voteMutation.isSuccess}
            idleLabel="Submit vote"
            pendingLabel="Voting…"
            confirmedLabel="Voted"
          />
          {submitHint && <span className="text-[13px] text-muted-foreground">{submitHint}</span>}
        </div>
      )}

      {showPendingBanner && selectedVoter && (
        <div ref={bannerRef} className="scroll-mt-6">
          <PendingAccountsBanner
            className="mx-auto"
            pending={pendingAccounts}
            votedAccount={{ address: selectedVoter, votingPower: selectedVoterPower }}
            totalAccounts={voterAccounts.length}
            onSwitchAndVote={switchAndVote}
          />
        </div>
      )}

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent onClose={() => setConnectOpen(false)} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect wallet</DialogTitle>
            <DialogDescription>Choose a wallet to connect to gGov.</DialogDescription>
          </DialogHeader>
          <WalletPicker onClose={() => setConnectOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )

  const sidebar = (
    <div className="space-y-6">
      {activeAddress &&
        (collectiveStatusReady ? (
          <CollectiveStatusCard
            totalVotingPower={collectiveVotingPower}
            connectedAccounts={voterAccounts.length}
            eligibleAccounts={collectiveEligible}
            votedAccounts={collectiveVoted}
            delegatedCount={allDelegators.length}
            periodStatus={status}
          />
        ) : (
          <Skeleton className="h-40" />
        ))}
      {activeAddress && <PooledSharePanel positions={pooled.positions} activeAddress={activeAddress} />}
      {selectedPooled?.topicVotes && !isEnded && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{selectedPooled.instanceName} vote record</CardTitle>
          </CardHeader>
          <CardContent>
            {!selectedPooled.ownerIsSelf && (
              <p className="mb-2 text-sm text-muted-foreground">
                Cast on behalf of <Address address={selectedPooled.owner} width={6} copy={false} tooltip={false} />.
              </p>
            )}
            {selectedPooled.topicVotes.map((votes, ti) => {
              const options = period.topics[ti]?.[0] ?? []
              const total = votes.reduce((a, b) => a + b, 0)
              const nonZero = votes
                .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, aq: v }))
                .filter((entry) => entry.aq > 0)
              if (nonZero.length === 0) return null
              return (
                <div key={ti} className="mb-2">
                  <span className="text-sm font-medium">{topicBodies[ti]?.title}:</span>{' '}
                  <span className="text-sm text-muted-foreground">
                    {nonZero
                      .map((e) => {
                        const pct = total > 0 ? ((e.aq / total) * 100).toFixed(1) : '0.0'
                        // AlgoQuarters as submitted, with what the pool turns them into.
                        return `${e.label} (≈ ${formatApprox(e.aq * votesPerAq)} votes, ${pct}%)`
                      })
                      .join(', ')}
                  </span>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
      {voteRecord && !isEnded && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> vote record
            </CardTitle>
          </CardHeader>
          <CardContent>
            {voteRecord.isDelegated && <p className="text-sm text-muted-foreground mb-2">Voted by delegator.</p>}
            {voteRecord.topicVotes.map((votes, ti) => {
              const options = period.topics[ti]?.[0] ?? []
              const total = votes.reduce((a, b) => a + b, 0)
              const nonZero = votes
                .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, votes: v }))
                .filter((entry) => entry.votes > 0)
              if (nonZero.length === 0) return null
              return (
                <div key={ti} className="mb-2">
                  <span className="text-sm font-medium">{topicBodies[ti]?.title}:</span>{' '}
                  <span className="text-sm text-muted-foreground">
                    {nonZero
                      .map((e) => {
                        const pct = total > 0 ? ((e.votes / total) * 100).toFixed(1) : '0.0'
                        return `${e.label} (${e.votes} votes, ${pct}%)`
                      })
                      .join(', ')}
                  </span>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
      <PeriodInfoCard
        votingStart={period.votingStart}
        votingEnd={period.votingEnd}
        topics={period.topics.length}
        topicsLabel={terms.Items}
        elections={terms.electionCount}
        votesCast={periodVotesCast}
        eligibleGovernors={eligibleGovernors}
        committeeHref={committeeIdB64 ? `/committees/${committeeIdB64}` : undefined}
      />
      <TechnicalInfoCard periodId={periodId} />
    </div>
  )

  return <SidebarLayout sidebar={sidebar}>{mainContent}</SidebarLayout>
}
