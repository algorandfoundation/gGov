import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useWallet } from "@txnlab/use-wallet-react";
import { useGGovSDK } from "@/hooks/useGGovSDK";
import { useCommitteeVotingPowers, useMyVotes, useDelegation, useDelegatedToMe } from "@/hooks/queries";
import { useDelegateMutation, useUndelegateMutation } from "@/hooks/mutations";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import { formatTimestamp } from "@/utils/time";
import Address from "@/components/Address";

export default function Account() {
  const { address } = useParams<{ address: string }>();
  const { activeAddress, activeWalletAccounts } = useWallet();
  const navigate = useNavigate();
  const { sdk } = useGGovSDK();
  const isOwnAccount = !!address && !!activeAddress && address === activeAddress;
  const hasMultipleAccounts = (activeWalletAccounts ?? []).length > 1;

  // Offer to jump to the now-active account's page when the user switches wallet
  // accounts while viewing what was their own account page.
  const [showSwitchBanner, setShowSwitchBanner] = useState(false);
  const prevActiveAddress = useRef(activeAddress);
  useEffect(() => {
    const previous = prevActiveAddress.current;
    prevActiveAddress.current = activeAddress;
    if (
      hasMultipleAccounts &&
      previous &&
      activeAddress &&
      previous !== activeAddress &&
      address === previous &&
      address !== activeAddress
    ) {
      setShowSwitchBanner(true);
    }
  }, [activeAddress, address, hasMultipleAccounts]);
  // Once the viewed page matches the active account again the prompt is moot.
  useEffect(() => {
    if (address === activeAddress) setShowSwitchBanner(false);
  }, [address, activeAddress]);
  const { data: committees = [], isLoading: loadingCommittees } = useCommitteeVotingPowers(address);
  const { data: votes = [], isLoading: loadingVotes } = useMyVotes(address);
  const { data: delegation, isLoading: loadingDelegation } = useDelegation(isOwnAccount ? address : undefined);
  const { data: delegators = [], isLoading: loadingDelegators } = useDelegatedToMe(address);
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
        Account <Address address={address} width={8} long className="text-lg text-muted-foreground" />
      </h1>

      {showSwitchBanner && activeAddress && (
        <div className="rounded-lg border border-accent bg-accent/20 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm">
            You switched accounts. View{" "}
            <Address address={activeAddress} width={8} className="font-mono" />
            's account page instead?
          </p>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => {
                setShowSwitchBanner(false);
                navigate(`/account/${activeAddress}`);
              }}
            >
              Switch to my account
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowSwitchBanner(false)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

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
                    <Address address={delegation.delegatee} to width={8} className="text-primary hover:underline" />
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
          <CardTitle className="text-base">{isOwnAccount ? "Delegated to You" : "Delegators"}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingDelegators ? (
            <Skeleton className="h-10" />
          ) : delegators.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts have delegated to this address.</p>
          ) : (
            <div className="space-y-2">
              {delegators.map((addr) => (
                <div key={addr}>
                  <Address address={addr} to width={8} className="text-sm text-primary hover:underline" />
                </div>
              ))}
              {isOwnAccount && (
                <p className="text-xs text-muted-foreground pt-1">
                  You can vote on their behalf from an active period's vote page.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

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
