import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWallet } from "@txnlab/use-wallet-react";
import { useGGovSDK } from "@/hooks/useGGovSDK";
import { useCommitteeVotingPowers, useMyVotes, useDelegation } from "@/hooks/queries";
import { useDelegateMutation, useUndelegateMutation } from "@/hooks/mutations";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import { formatTimestamp } from "@/utils/time";
import { ellipseAddress } from "@/utils/ellipseAddress";

export default function Account() {
  const { address } = useParams<{ address: string }>();
  const { activeAddress } = useWallet();
  const { sdk } = useGGovSDK();
  const isOwnAccount = !!address && !!activeAddress && address === activeAddress;
  const { data: committees = [], isLoading: loadingCommittees } = useCommitteeVotingPowers(address);
  const { data: votes = [], isLoading: loadingVotes } = useMyVotes(address);
  const { data: delegation, isLoading: loadingDelegation } = useDelegation(isOwnAccount ? address : undefined);
  const delegateMutation = useDelegateMutation();
  const undelegateMutation = useUndelegateMutation();
  const [delegateeInput, setDelegateeInput] = useState("");
  const submitting = delegateMutation.isPending || undelegateMutation.isPending;

  if (!address) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Account</h1>
        <p className="text-muted-foreground">No account address provided.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">
        Account <span className="font-mono text-lg text-muted-foreground">{ellipseAddress(address, 8)}</span>
      </h1>

      <div className={isOwnAccount ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : ""}>
        {isOwnAccount && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delegation</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingDelegation ? (
                <Skeleton className="h-10" />
              ) : delegation?.exists ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    Delegated to:{" "}
                    <Link to={`/account/${delegation.delegatee}`} className="font-mono text-primary hover:underline">
                      {ellipseAddress(delegation.delegatee, 8)}
                    </Link>
                  </p>
                  <Button variant="destructive" size="sm" onClick={() => undelegateMutation.mutate()} disabled={submitting}>
                    {undelegateMutation.isPending ? "Removing..." : "Remove Delegation"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">No active delegation.</p>
                  <div className="space-y-2">
                    <Label htmlFor="delegate-to">Delegate to</Label>
                    <Input
                      id="delegate-to"
                      name="delegate-to"
                      placeholder="Enter Algorand address..."
                      value={delegateeInput}
                      onChange={(e) => setDelegateeInput(e.target.value)}
                    />
                  </div>
                  <Button onClick={() => delegateMutation.mutate(delegateeInput)} disabled={submitting || !delegateeInput || !sdk}>
                    {delegateMutation.isPending ? "Delegating..." : "Delegate"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Voting Power by Committee</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingCommittees ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : committees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No committees found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Committee (Rounds)</TableHead>
                    <TableHead className="text-right">Voting Power</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {committees.map((c) => (
                    <TableRow key={c.idBase64Url}>
                      <TableCell>
                        <Link to={`/committees/${c.idBase64Url}`} className="text-primary hover:underline">
                          {c.periodStart} — {c.periodEnd}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.votingPower}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Votes Cast</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingVotes ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : votes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No votes cast yet.</p>
          ) : (
            <div className="space-y-4">
              {votes.map(({ periodId, period, record, body, topicBodies }) => (
                <Card key={periodId}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Link to={`/vote/period/${periodId}`} className="text-sm font-medium text-primary hover:underline">
                          {body?.title ?? `Period #${periodId}`}
                        </Link>
                        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
                      </div>
                      {record.byDelegator && <span className="text-xs text-muted-foreground">Voted by delegator</span>}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {record.topicVotes.map((topicVoteCounts, ti) => {
                      const options = period.topics[ti]?.[0] ?? [];
                      const total = topicVoteCounts.reduce((a, b) => a + b, 0);
                      const nonZero = topicVoteCounts
                        .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, votes: v }))
                        .filter((entry) => entry.votes > 0);
                      if (nonZero.length === 0) return null;
                      return (
                        <div key={ti} className="mb-2">
                          <span className="text-sm font-medium">{topicBodies[ti]?.title ?? `Topic ${ti + 1}`}:</span>{" "}
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
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
