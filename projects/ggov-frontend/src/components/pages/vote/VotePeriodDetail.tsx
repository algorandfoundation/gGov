import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useWallet } from "@txnlab/use-wallet-react";
import { useGGovSDK } from "@/hooks/useGGovSDK";
import { usePeriod, usePeriodBody, useTopicBodies, useCanVote, useVoteRecord, useAllDelegations, useVoteStatuses, useCanVoteMany, useVoteRecordMany, useCommittee, useXGovVotingPowers } from "@/hooks/queries";
import { useVoteMutation } from "@/hooks/mutations";
import Address from "@/components/Address";
import AccountSelector, { AccountSelectorItem } from "@/components/AccountSelector";
import TopicVoteCard from "@/components/TopicVoteCard";
import SidebarLayout from "@/components/SidebarLayout";
import CollectiveStatusCard from "@/components/CollectiveStatusCard";
import ConnectedWalletsEligibility from "@/components/ConnectedWalletsEligibility";
import PeriodInfoCard from "@/components/PeriodInfoCard";
import BackButton from "@/components/BackButton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ClampedMarkdown } from "@/components/ui/clamped-markdown";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import TechnicalInfoCard from "@/components/TechnicalInfoCard";
import { formatTimestamp, periodStatus, type PeriodStatus } from "@/utils/time";
import { toBase64Url } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import { TxButtonContent } from "@/components/TxButtonContent";

function VoteAllocationSummary({ allocated, power }: { allocated: number; power: number }) {
  const remaining = power - allocated;
  return (
    <div className={cn("text-xs mt-2 tabular-nums", remaining === 0 ? "text-muted-foreground" : "text-destructive")}>
      {remaining === 0
        ? `${allocated} / ${power} votes allocated`
        : remaining > 0
          ? `${allocated} / ${power} votes allocated (${remaining} remaining)`
          : `${allocated} / ${power} votes allocated (${-remaining} over)`}
    </div>
  );
}

/**
 * Tense-adjusted eligibility wording for the connected voter. `self` is the full
 * sentence when voting for yourself; `suffix` follows an `<Address>` when voting
 * for someone else; `muted` styles it as secondary rather than emphasised.
 */
function eligibilityCopy(status: PeriodStatus, canVote: boolean): { self: string; suffix: string; muted: boolean } {
  if (canVote) {
    if (status === "active") return { self: "You are eligible to vote", suffix: "is eligible to vote", muted: false };
    if (status === "upcoming")
      return {
        self: "You'll be eligible to vote when voting opens",
        suffix: "will be eligible to vote when voting opens",
        muted: false,
      };
    return { self: "Voting has closed — you did not vote in this period", suffix: "did not vote in this period", muted: true };
  }
  if (status === "active") return { self: "You cannot vote in this period", suffix: "cannot vote in this period", muted: true };
  if (status === "upcoming")
    return { self: "You are not eligible to vote in this period", suffix: "is not eligible to vote in this period", muted: true };
  return { self: "You were not eligible to vote in this period", suffix: "were not eligible to vote in this period", muted: true };
}

export default function VotePeriodDetail() {
  const { periodId: pidParam } = useParams<{ periodId: string }>();
  const periodId = Number(pidParam);
  const { sdk } = useGGovSDK();
  const { activeAddress, activeWallet, activeWalletAccounts } = useWallet();
  const walletAddresses = (activeWalletAccounts ?? []).map((a) => a.address);

  // Account being voted for: yourself by default, or an account that delegated to you.
  const [selectedVoter, setSelectedVoter] = useState<string | null>(activeAddress ?? null);
  // When we switch the active account in order to vote as one of its delegators,
  // remember that delegator so the reset-on-switch below keeps it selected.
  const pendingVoterRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingVoterRef.current) {
      setSelectedVoter(pendingVoterRef.current);
      pendingVoterRef.current = null;
    } else {
      setSelectedVoter(activeAddress ?? null);
    }
  }, [activeAddress]);

  const { data: period, isLoading } = usePeriod(periodId);
  const { data: periodBody } = usePeriodBody(periodId);
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0);
  // The period's committee drives the eligible-governor count and the
  // window-independent voting power used for non-active display.
  const committeeIdB64 = period ? toBase64Url(period.committeeId) : undefined;
  const { data: committee } = useCommittee(committeeIdB64);

  // Group every delegation that targets one of the wallet's accounts, so each
  // account shows its delegated accounts up front — no need to switch to it.
  const { data: allDelegations } = useAllDelegations();
  const walletAddressSet = new Set(walletAddresses);
  const delegatorsByDelegatee: Record<string, string[]> = {};
  const delegateeOf: Record<string, string> = {};
  if (allDelegations) {
    for (const [delegator, delegatee] of allDelegations) {
      if (!walletAddressSet.has(delegatee)) continue;
      (delegatorsByDelegatee[delegatee] ??= []).push(delegator);
      delegateeOf[delegator] = delegatee;
    }
  }
  const allDelegators = Object.keys(delegateeOf);
  // Delegators of the currently active account (for the self-power fallback below).
  const delegators = delegatorsByDelegatee[activeAddress ?? ""] ?? [];

  // Vote status for every selectable account, to badge those that haven't voted yet.
  const voterAccounts = Array.from(new Set([...walletAddresses, ...allDelegators]));
  const voteStatuses = useVoteStatuses(periodId, voterAccounts);
  // Window-independent voting power per account (the registry doesn't gate on the
  // voting window, unlike canVote), so the sidebar shows real standing in
  // upcoming/ended periods too.
  const xgovPowers = useXGovVotingPowers(committeeIdB64, voterAccounts);
  // Records for delegators expose `isDelegated`, telling us when a delegator
  // voted directly (a state the delegatee cannot override).
  const delegatorRecords = useVoteRecordMany(periodId, allDelegators);
  // Eligibility + voting power. Own wallet accounts vote as themselves (sender =
  // voter); each delegator is checked against the account it delegated to.
  const walletEligibility = useCanVoteMany(periodId, walletAddresses);
  const delegatorEligibility = useCanVoteMany(periodId, allDelegators, delegateeOf);
  // For delegated voting, the connected wallet (activeAddress) is the sender; selectedVoter is the voter.
  const { data: canVoteResult } = useCanVote(periodId, selectedVoter, activeAddress);
  // Whether the connected wallet has voting power of its own; if not, hide the "Yourself" option.
  const { data: selfCanVoteResult } = useCanVote(periodId, activeAddress, activeAddress);
  const selfCanVote = (selfCanVoteResult?.votingPower ?? 0n) > 0n;
  const { data: voteRecord } = useVoteRecord(periodId, selectedVoter);
  const voteMutation = useVoteMutation();

  // If the connected wallet has no voting power of its own, fall back to the first
  // delegator so we never leave the (now hidden) "Yourself" option selected.
  useEffect(() => {
    if (selfCanVoteResult && !selfCanVote && selectedVoter === activeAddress && delegators.length > 0) {
      setSelectedVoter(delegators[0]);
    }
    // `delegators` is rebuilt every render; depend on its first element (a stable
    // primitive) so this fallback doesn't re-run on every render.
  }, [selfCanVoteResult, selfCanVote, selectedVoter, activeAddress, delegators[0]]);

  const votingForSelf = selectedVoter === activeAddress;

  const [advancedMode, setAdvancedMode] = useState(false);
  // Simple mode: selected option index per topic (-1 = none selected)
  const [simpleSelections, setSimpleSelections] = useState<number[]>([]);
  // Advanced mode: manual vote allocation
  const [topicVotes, setTopicVotes] = useState<number[][][]>([]);

  // Seed ballot state once per period. Keying on periodId (not the `period`
  // object identity) stops a background refetch — e.g. on window refocus — from
  // wiping the voter's in-progress selections.
  const seededBallotPeriodId = useRef<number | null>(null);
  useEffect(() => {
    if (period && seededBallotPeriodId.current !== periodId) {
      seededBallotPeriodId.current = periodId;
      setSimpleSelections(period.topics.map(() => -1));
      setTopicVotes(period.topics.map(([options]) => [options.map(() => 0)]));
    }
  }, [period, periodId]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!period) {
    return <p className="text-muted-foreground">Period not found.</p>;
  }

  const status = periodStatus(period.votingStart, period.votingEnd);
  const isActive = status === "active";
  const isUpcoming = status === "upcoming";
  const showVoteForm = isActive && canVoteResult?.canVote && sdk;
  const votingPower = canVoteResult?.votingPower ?? 0n;

  // Selecting one of the wallet's own accounts switches the active (signing)
  // account — the activeAddress effect then points selectedVoter at it.
  // Selecting a delegator votes on its behalf; its delegatee must be the active
  // (signing) account, so switch to that delegatee first if needed.
  function handleSelectVoter(addr: string) {
    if (walletAddresses.includes(addr)) {
      if (addr !== activeAddress) activeWallet?.setActiveAccount(addr);
      setSelectedVoter(addr);
      return;
    }
    const delegatee = delegateeOf[addr];
    if (delegatee && delegatee !== activeAddress && activeWallet) {
      // Stash the delegator only once we know the signer switch will run, so a
      // no-op setActiveAccount can't leave a stale ref to apply on a later switch.
      pendingVoterRef.current = addr;
      activeWallet.setActiveAccount(delegatee);
    } else {
      setSelectedVoter(addr);
    }
  }

  function handleSimpleSelect(topicIdx: number, optionIdx: number) {
    setSimpleSelections((prev) => {
      const next = [...prev];
      next[topicIdx] = prev[topicIdx] === optionIdx ? -1 : optionIdx;
      return next;
    });
  }

  function handleAdvancedVoteChange(topicIdx: number, optionIdx: number, value: number) {
    setTopicVotes((prev) => {
      const next = prev.map((t) => t.map((opts) => [...opts]));
      next[topicIdx][0][optionIdx] = value;
      return next;
    });
  }

  function buildVotes(): number[][] {
    if (advancedMode) {
      return topicVotes.map((t) => t[0]);
    }
    // Simple mode: all voting power to the selected option
    return period!.topics.map(([options], topicIdx) => {
      const selected = simpleSelections[topicIdx];
      return options.map((_, optIdx) => (optIdx === selected ? Number(votingPower) : 0));
    });
  }

  function submitVote() {
    if (!selectedVoter) return;
    voteMutation.mutate(
      { periodId, voterAccount: selectedVoter, topicVotes: buildVotes() },
      // Return to simple mode once an advanced-mode vote lands.
      { onSuccess: () => setAdvancedMode(false) },
    );
  }

  const canSubmitSimple = simpleSelections.length > 0 && simpleSelections.every((s) => s >= 0);
  const power = Number(votingPower);
  const advancedTopicTotals = topicVotes.map((t) => t[0]?.reduce((a, b) => a + b, 0) ?? 0);
  const advancedValid = advancedTopicTotals.length > 0 && advancedTopicTotals.every((t) => t === power);
  const canSubmit = advancedMode ? advancedValid : canSubmitSimple;

  // Aggregate standing across every account the wallet can act for (its own
  // accounts plus any delegators), shown in the Collective Status sidebar card.
  // Uses registry voting power so it's correct in non-active periods too.
  let collectiveVotingPower = 0n;
  let collectiveEligible = 0;
  let collectiveVoted = 0;
  for (const addr of voterAccounts) {
    const vp = xgovPowers[addr] ?? 0;
    if (vp > 0) {
      collectiveVotingPower += BigInt(vp);
      collectiveEligible++;
      if (voteStatuses[addr]) collectiveVoted++;
    }
  }
  // `xgovPowers` is `undefined` per account until its query settles. Treating that
  // as 0 would briefly render the card's "Not eligible to vote" state before the
  // powers load, so hold the card back until every voter account has resolved.
  const collectiveStatusReady = voterAccounts.every((addr) => xgovPowers[addr] !== undefined);

  // Per-wallet eligibility for the non-active expandable list. Outside the voting
  // window eligibility is registry voting power (canVote is false for everyone),
  // and an account is "delegated" when it isn't one of the wallet's own accounts.
  const walletEligibilityItems = voterAccounts.map((addr) => ({
    address: addr,
    votingPower: xgovPowers[addr] ?? 0,
    eligible: (xgovPowers[addr] ?? 0) > 0,
    voted: !!voteStatuses[addr],
    delegated: !walletAddresses.includes(addr),
  }));

  // Eligibility wording: during the active window canVote is authoritative (it
  // also reflects delegation/override rules); outside it canVote returns false
  // for everyone, so fall back to registry voting power.
  const selectedVoterPower = selectedVoter ? xgovPowers[selectedVoter] ?? 0 : 0;
  const eligibleToVote = isActive ? !!canVoteResult?.canVote : selectedVoterPower > 0;
  const eligibility = canVoteResult ? eligibilityCopy(status, eligibleToVote) : null;

  // Total voting power exercised in the period. A voter spreads their full power
  // across each topic, so any topic's tally sum reflects total participation; we
  // take the max so a not-yet-tallied topic doesn't understate it.
  const periodVotesCast = period.topics.reduce(
    (max, [, tallies]) => Math.max(max, tallies.reduce((a, b) => a + b, 0)),
    0,
  );

  // The committee's member count is the number of eligible governors.
  const eligibleGovernors = committee?.totalMembers;

  const mainContent = (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BackButton to="/vote" />
        <h1 className="text-2xl font-bold">{periodBody?.title}</h1>
        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
      </div>

      {periodBody?.body && <ClampedMarkdown lines={9}>{periodBody.body}</ClampedMarkdown>}

      {isActive && activeAddress && voterAccounts.length >= 1 && (
        <AccountSelector
          className="mx-auto max-w-2xl"
          selected={selectedVoter}
          onSelect={handleSelectVoter}
          accounts={walletAddresses.map<AccountSelectorItem>((addr) => ({
            address: addr,
            votingPower: walletEligibility[addr]?.votingPower,
            canVote: walletEligibility[addr]?.canVote,
            hasVoted: voteStatuses[addr],
            // Accounts that delegated to this one nest under it as children.
            delegated: (delegatorsByDelegatee[addr] ?? []).map<AccountSelectorItem>((d) => {
              const record = delegatorRecords[d];
              return {
                address: d,
                votingPower: delegatorEligibility[d]?.votingPower,
                canVote: delegatorEligibility[d]?.canVote,
                hasVoted: voteStatuses[d],
                // Voted for itself (not via a delegate) → the delegate can't override.
                votedDirectly: record != null && record.topicVotes != null && !record.isDelegated,
              };
            }),
          }))}
        />
      )}

      {activeAddress && !isActive && voterAccounts.length > 0 && collectiveStatusReady && (
        <ConnectedWalletsEligibility items={walletEligibilityItems} eligibleCount={collectiveEligible} periodStatus={status} />
      )}

      {activeAddress && isActive && (voteRecord || eligibility) && (
        <div className="text-center text-sm">
          {voteRecord ? (
            <span className="text-muted-foreground">
              You can change your vote until {formatTimestamp(period.votingEnd)}
            </span>
          ) : (
            <span className={eligibility!.muted ? "text-muted-foreground" : "font-bold"}>
              {votingForSelf ? (
                eligibility!.self
              ) : (
                <>
                  <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> {eligibility!.suffix}
                </>
              )}
            </span>
          )}
        </div>
      )}

      {isActive && !votingForSelf && voteRecord && !voteRecord.isDelegated && (
        <div className="max-w-lg rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> has already voted directly, so you cannot vote on their
          behalf. A delegate cannot override a vote the account holder cast themselves.
        </div>
      )}

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Topics</h2>
        {showVoteForm && (
          <button
            type="button"
            className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setAdvancedMode((v) => !v)}
          >
            {advancedMode ? "Simple mode" : "Advanced mode"}
          </button>
        )}
      </div>

      {period.topics.length === 0 ? (
        <p className="text-muted-foreground">No topics in this period.</p>
      ) : (
        <div className="space-y-4">
          {period.topics.map(([options, tallies], topicIdx) => {
            const tb = topicBodies[topicIdx];
            const mode = isUpcoming ? "upcoming" : showVoteForm ? (advancedMode ? "advanced" : "select") : "results";
            return (
              <TopicVoteCard
                key={topicIdx}
                topicIdx={topicIdx}
                title={tb?.title}
                body={tb?.body}
                options={options}
                tallies={tallies}
                mode={mode}
                selectedOption={mode === "select" ? simpleSelections[topicIdx] ?? -1 : -1}
                onSelect={(optIdx) => handleSimpleSelect(topicIdx, optIdx)}
                advancedVotes={topicVotes[topicIdx]?.[0]}
                onAdvancedChange={(optIdx, value) => handleAdvancedVoteChange(topicIdx, optIdx, value)}
                footer={
                  showVoteForm && advancedMode ? (
                    <VoteAllocationSummary allocated={advancedTopicTotals[topicIdx]} power={power} />
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}

      {showVoteForm && (
        <Button onClick={submitVote} disabled={voteMutation.isPending || !canSubmit} aria-busy={voteMutation.isPending}>
          <TxButtonContent
            pending={voteMutation.isPending}
            success={voteMutation.isSuccess}
            idleLabel="Submit vote"
            pendingLabel="Voting…"
            confirmedLabel="Voted"
          />
        </Button>
      )}
    </div>
  );

  const sidebar = (
    <div className="space-y-6">
      {activeAddress && (
        collectiveStatusReady ? (
          <CollectiveStatusCard
            totalVotingPower={collectiveVotingPower}
            connectedAccounts={voterAccounts.length}
            eligibleAccounts={collectiveEligible}
            votedAccounts={collectiveVoted}
            hasDelegations={allDelegators.length > 0}
            periodStatus={status}
          />
        ) : (
          <Skeleton className="h-40" />
        )
      )}
      {voteRecord && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> vote record
            </CardTitle>
          </CardHeader>
          <CardContent>
            {voteRecord.isDelegated && <p className="text-sm text-muted-foreground mb-2">Voted by delegator.</p>}
            {voteRecord.topicVotes.map((votes, ti) => {
              const options = period.topics[ti]?.[0] ?? [];
              const total = votes.reduce((a, b) => a + b, 0);
              const nonZero = votes
                .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, votes: v }))
                .filter((entry) => entry.votes > 0);
              if (nonZero.length === 0) return null;
              return (
                <div key={ti} className="mb-2">
                  <span className="text-sm font-medium">{topicBodies[ti]?.title}:</span>{" "}
                  <span className="text-sm text-muted-foreground">
                    {nonZero
                      .map((e) => {
                        const pct = total > 0 ? ((e.votes / total) * 100).toFixed(1) : "0.0";
                        return `${e.label} (${e.votes} votes, ${pct}%)`;
                      })
                      .join(", ")}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
      <PeriodInfoCard
        votingStart={period.votingStart}
        votingEnd={period.votingEnd}
        topics={period.topics.length}
        votesCast={periodVotesCast}
        eligibleGovernors={eligibleGovernors}
        committeeHref={committeeIdB64 ? `/committees/${committeeIdB64}` : undefined}
      />
      <TechnicalInfoCard periodId={periodId} />
    </div>
  );

  return <SidebarLayout sidebar={sidebar}>{mainContent}</SidebarLayout>;
}
