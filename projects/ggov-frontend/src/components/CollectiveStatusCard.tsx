import { Wallet, Network, CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface CollectiveStatusCardProps {
  /** Combined voting power across every account the connected wallet can vote with. */
  totalVotingPower: bigint;
  /** Accounts the wallet controls for voting (its own accounts + delegators). */
  connectedAccounts: number;
  /** How many of those accounts actually have voting power in this period. */
  eligibleAccounts: number;
  /** How many of the eligible accounts have already cast a vote. */
  votedAccounts: number;
  /** Whether the wallet holds voting power delegated from other accounts. */
  hasDelegations: boolean;
  /** Whether the period has ended — switches the banner to a past-tense summary. */
  periodEnded?: boolean;
  className?: string;
}

/**
 * At-a-glance summary of the connected wallet's collective standing in a voting
 * period: aggregate voting power, how many accounts back it, and eligibility.
 */
export default function CollectiveStatusCard({
  totalVotingPower,
  connectedAccounts,
  eligibleAccounts,
  votedAccounts,
  hasDelegations,
  periodEnded = false,
  className,
}: CollectiveStatusCardProps) {
  const pending = eligibleAccounts - votedAccounts;
  const plural = (n: number) => (n !== 1 ? "s" : "");
  // No voting power → ineligible; otherwise green once every eligible account has
  // voted. While active, amber prompts the accounts that still need to vote; once
  // ended, the same row becomes a neutral past-tense tally.
  const status =
    eligibleAccounts === 0
      ? {
          tone: "border-destructive/30 bg-destructive/5 text-destructive",
          icon: XCircle,
          label: periodEnded ? "Was not eligible to vote" : "Not eligible to vote",
        }
      : pending === 0
        ? { tone: "border-primary/20 bg-primary/5 text-foreground", icon: CheckCircle2, label: "All accounts voted" }
        : periodEnded
          ? {
              tone: "border-border bg-muted/40 text-muted-foreground",
              icon: Info,
              label: `${votedAccounts}/${eligibleAccounts} account${plural(eligibleAccounts)} voted`,
            }
          : {
              tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              icon: AlertTriangle,
              label: `${pending}/${eligibleAccounts} account${plural(eligibleAccounts)} need to vote`,
            };
  const StatusIcon = status.icon;

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Collective Status</CardTitle>
        <Wallet className="size-5 text-primary" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total Voting Power</p>
          <p className="text-2xl font-bold tabular-nums">{totalVotingPower.toLocaleString()}</p>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-primary">
            <Network className="size-4" />
            <span>
              {connectedAccounts} connected account{connectedAccounts !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-sm", status.tone)}>
          <StatusIcon className="size-4 shrink-0" />
          <span>{status.label}</span>
        </div>

        {hasDelegations && !periodEnded && (
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>You hold voting power delegated from other accounts. Each account is voted for separately.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
