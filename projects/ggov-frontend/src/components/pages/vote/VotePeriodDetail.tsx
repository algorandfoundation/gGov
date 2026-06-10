import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useWallet } from "@txnlab/use-wallet-react";
import { useGGovSDK } from "@/hooks/useGGovSDK";
import { usePeriod, usePeriodBody, useTopicBodies, useCanVote, useVoteRecord, useDelegatedToMe, useVoteStatuses } from "@/hooks/queries";
import { useVoteMutation } from "@/hooks/mutations";
import Address from "@/components/Address";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownContent } from "@/components/ui/markdown-content";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import { formatTimestamp, periodStatus } from "@/utils/time";
import { toBase64Url } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/** Red dot shown on a "Vote as" account that has not voted in this period yet. */
function NotVotedBadge() {
  return (
    <span
      className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background"
      aria-label="Has not voted yet"
      title="Has not voted yet"
    />
  );
}

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

export default function VotePeriodDetail() {
  const { periodId: pidParam } = useParams<{ periodId: string }>();
  const periodId = Number(pidParam);
  const { sdk } = useGGovSDK();
  const { activeAddress } = useWallet();

  // Account being voted for: yourself by default, or an account that delegated to you.
  const [selectedVoter, setSelectedVoter] = useState<string | null>(activeAddress ?? null);
  useEffect(() => {
    setSelectedVoter(activeAddress ?? null);
  }, [activeAddress]);

  const { data: period, isLoading } = usePeriod(periodId);
  const { data: periodBody } = usePeriodBody(periodId);
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0);
  const { data: delegators = [] } = useDelegatedToMe(activeAddress);
  // Vote status for every account in the "Vote as" group, to badge those that haven't voted yet.
  const voterAccounts = activeAddress ? [activeAddress, ...delegators] : [];
  const voteStatuses = useVoteStatuses(periodId, voterAccounts);
  // For delegated voting, the connected wallet (activeAddress) is the sender; selectedVoter is the voter.
  const { data: canVoteResult } = useCanVote(periodId, selectedVoter, activeAddress);
  // Whether the connected wallet has voting power of its own; if not, hide the "Yourself" option.
  const { data: selfCanVoteResult } = useCanVote(periodId, activeAddress, activeAddress);
  const selfCanVote = (selfCanVoteResult?.votingPower ?? 0n) > 0n;
  const { data: voteRecord } = useVoteRecord(periodId, selectedVoter);
  const voteMutation = useVoteMutation();

  useEffect(() => {
    if (selectedVoter) {
      console.log(`Voting record for ${selectedVoter} (period ${periodId}):`, voteRecord);
    }
  }, [selectedVoter, periodId, voteRecord]);

  // If the connected wallet has no voting power of its own, fall back to the first
  // delegator so we never leave the (now hidden) "Yourself" option selected.
  useEffect(() => {
    if (selfCanVoteResult && !selfCanVote && selectedVoter === activeAddress && delegators.length > 0) {
      setSelectedVoter(delegators[0]);
    }
  }, [selfCanVoteResult, selfCanVote, selectedVoter, activeAddress, delegators]);

  const votingForSelf = selectedVoter === activeAddress;

  const [advancedMode, setAdvancedMode] = useState(false);
  // Simple mode: selected option index per topic (-1 = none selected)
  const [simpleSelections, setSimpleSelections] = useState<number[]>([]);
  // Advanced mode: manual vote allocation
  const [topicVotes, setTopicVotes] = useState<number[][][]>([]);

  useEffect(() => {
    if (period) {
      setSimpleSelections(period.topics.map(() => -1));
      setTopicVotes(period.topics.map(([options]) => [options.map(() => 0)]));
    }
  }, [period]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{periodBody?.title}</h1>
        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
      </div>

      {periodBody?.body && <MarkdownContent>{periodBody.body}</MarkdownContent>}

      <div className="text-sm text-muted-foreground">
        Voting: {formatTimestamp(period.votingStart)} — {formatTimestamp(period.votingEnd)}
      </div>

      <div className="text-sm text-muted-foreground">
        <Link to={`/committees/${toBase64Url(period.committeeId)}`} className="text-primary hover:underline">
          View committee
        </Link>
      </div>

      {activeAddress && delegators.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Vote as:</span>
          {selfCanVote && (
            <button
              type="button"
              className={cn(
                "relative rounded-md border px-2.5 py-1 transition-colors",
                votingForSelf ? "border-primary bg-primary/5" : "border-border hover:border-foreground/20",
              )}
              onClick={() => setSelectedVoter(activeAddress)}
            >
              Yourself
              {voteStatuses[activeAddress] === false && <NotVotedBadge />}
            </button>
          )}
          {delegators.map((addr) => (
            <button
              key={addr}
              type="button"
              className={cn(
                "relative rounded-md border px-2.5 py-1 transition-colors",
                selectedVoter === addr ? "border-primary bg-primary/5" : "border-border hover:border-foreground/20",
              )}
              onClick={() => setSelectedVoter(addr)}
            >
              <Address address={addr} width={6} copy={false} tooltip={false} />
              {voteStatuses[addr] === false && <NotVotedBadge />}
            </button>
          ))}
        </div>
      )}

      {activeAddress && canVoteResult && !voteRecord && (
        <div className="text-sm">
          {canVoteResult.canVote ? (
            <span className="font-bold">
              {votingForSelf ? (
                "You are eligible to vote"
              ) : (
                <>
                  <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> is eligible to vote
                </>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {votingForSelf ? (
                "You cannot vote in this period"
              ) : (
                <>
                  <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> cannot vote in this period
                </>
              )}
            </span>
          )}
        </div>
      )}

      {isActive && !votingForSelf && voteRecord && !voteRecord.byDelegator && (
        <div className="max-w-lg rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <Address address={selectedVoter!} width={6} copy={false} tooltip={false} /> has already voted directly, so you cannot vote on their
          behalf. A delegate cannot override a vote the account holder cast themselves.
        </div>
      )}

      {voteRecord && (
        <Card className="max-w-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {votingForSelf ? (
                "Your Vote Record"
              ) : (
                <>
                  Vote Record — <Address address={selectedVoter!} width={6} copy={false} tooltip={false} />
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {voteRecord.byDelegator && <p className="text-sm text-muted-foreground mb-2">Voted by delegator.</p>}
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
            <p className="text-sm text-muted-foreground">
              <span className="">You can change your vote until {formatTimestamp(period.votingEnd)}</span>
            </p>
          </CardContent>
        </Card>
      )}

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Topics</h2>
        {showVoteForm && (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
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
            const selectedOption = simpleSelections[topicIdx] ?? -1;
            return (
              <Card key={topicIdx}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{tb?.title}</CardTitle>
                  {tb?.body && (
                    <CardDescription>
                      <MarkdownContent>{tb.body}</MarkdownContent>
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  {isUpcoming ? (
                    <p className="text-sm text-muted-foreground">Options: {options.join(", ")}</p>
                  ) : (
                    <div className="space-y-2">
                      {options.map((option, optIdx) => {
                        const tally = tallies[optIdx] ?? 0;
                        const totalVotes = tallies.reduce((a, b) => a + b, 0);
                        const pct = totalVotes > 0 ? (tally / totalVotes) * 100 : 0;
                        const isSelected = selectedOption === optIdx;
                        return (
                          <div key={optIdx} className="space-y-1">
                            {showVoteForm && !advancedMode ? (
                              <button
                                type="button"
                                className={cn(
                                  "w-full rounded-md border p-3 text-left transition-colors",
                                  isSelected ? "border-primary bg-primary/5" : "border-border hover:border-foreground/20",
                                )}
                                onClick={() => handleSimpleSelect(topicIdx, optIdx)}
                              >
                                <div className="flex items-center justify-between text-sm">
                                  <div className="flex items-center gap-2">
                                    <div
                                      className={cn(
                                        "h-4 w-4 rounded-full border-2 flex items-center justify-center",
                                        isSelected ? "border-primary" : "border-muted-foreground/40",
                                      )}
                                    >
                                      {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                                    </div>
                                    <span>{option}</span>
                                  </div>
                                  <span className="text-muted-foreground tabular-nums">
                                    {tally} ({pct.toFixed(1)}%)
                                  </span>
                                </div>
                                <div className="h-2 rounded-full bg-muted overflow-hidden mt-2">
                                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                                </div>
                              </button>
                            ) : (
                              <>
                                <div className="flex items-center justify-between text-sm">
                                  <span>{option}</span>
                                  <span className="text-muted-foreground tabular-nums">
                                    {tally} ({pct.toFixed(1)}%)
                                  </span>
                                </div>
                                <div className="h-2 rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                                </div>
                                {showVoteForm && advancedMode && (
                                  <div className="flex items-center gap-2 pt-1">
                                    <Label htmlFor={`votes-${topicIdx}-${optIdx}`} className="text-xs w-20">
                                      Your votes:
                                    </Label>
                                    <Input
                                      id={`votes-${topicIdx}-${optIdx}`}
                                      name={`votes-${topicIdx}-${optIdx}`}
                                      type="number"
                                      min={0}
                                      className="h-7 w-24 text-xs tabular-nums"
                                      value={topicVotes[topicIdx]?.[0]?.[optIdx] ?? 0}
                                      onChange={(e) => handleAdvancedVoteChange(topicIdx, optIdx, Number(e.target.value))}
                                    />
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {showVoteForm && advancedMode && <VoteAllocationSummary allocated={advancedTopicTotals[topicIdx]} power={power} />}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showVoteForm && (
        <Button onClick={submitVote} disabled={voteMutation.isPending || !canSubmit}>
          {voteMutation.isPending ? "Submitting..." : "Submit Vote"}
        </Button>
      )}
    </div>
  );
}
