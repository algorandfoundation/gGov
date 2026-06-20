import { Eyebrow } from "@/components/ui/eyebrow";
import { cn } from "@/lib/utils";
import type { PeriodStatus } from "@/utils/time";

interface CollectiveStatusCardProps {
  /** Combined voting power across every account the connected wallet can vote with. */
  totalVotingPower: bigint;
  /** Accounts the wallet controls for voting (its own accounts + delegators). */
  connectedAccounts: number;
  /** How many of those accounts actually have voting power in this period. */
  eligibleAccounts: number;
  /** How many of the eligible accounts have already cast a vote. */
  votedAccounts: number;
  /** How many of the accounts reached the wallet via delegation. */
  delegatedCount: number;
  /**
   * Period status. Outside the active window (`upcoming`/`ended`) the strip is
   * a neutral eligible-count summary; during `active` it nudges accounts to vote.
   */
  periodStatus: PeriodStatus;
  className?: string;
}

/**
 * At-a-glance summary of the connected wallet's collective standing in a voting
 * period: aggregate voting power, the accounts that back it, and a tone-coded
 * status strip (vote-drive while active, neutral eligible-count otherwise).
 */
export default function CollectiveStatusCard({
  totalVotingPower,
  connectedAccounts,
  eligibleAccounts,
  votedAccounts,
  delegatedCount,
  periodStatus,
  className,
}: CollectiveStatusCardProps) {
  const pending = eligibleAccounts - votedAccounts;
  const plural = (n: number) => (n !== 1 ? "s" : "");
  const isActive = periodStatus === "active";

  // Tone-coded status strip. Outside the active window it's a neutral count of
  // eligible wallets. During the window it tracks the vote drive: red when
  // nothing is eligible, green once every eligible account has voted, else amber
  // prompting the accounts that still need to vote.
  const strip = !isActive
    ? eligibleAccounts > 0
      ? {
          bg: "bg-success/[0.12]",
          dot: "bg-success",
          text: "text-success-strong",
          label: `${eligibleAccounts} of ${connectedAccounts} connected wallet${plural(connectedAccounts)} eligible`,
        }
      : {
          bg: "bg-muted/40",
          dot: "bg-muted-foreground",
          text: "text-muted-foreground",
          label: `0 of ${connectedAccounts} connected wallet${plural(connectedAccounts)} eligible`,
        }
    : eligibleAccounts === 0
      ? { bg: "bg-destructive/5", dot: "bg-destructive", text: "text-destructive", label: "Not eligible to vote" }
      : pending === 0
        ? { bg: "bg-success/[0.12]", dot: "bg-success", text: "text-success-strong", label: "All accounts voted" }
        : {
            bg: "bg-warning/[0.16]",
            dot: "bg-warning-strong",
            text: "text-[#7A5A00] dark:text-warning",
            label: `${pending} of ${eligibleAccounts} account${plural(eligibleAccounts)} still need to vote`,
          };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        isActive && "border-t-[3px] border-t-algo-blue dark:border-t-algo-teal",
        className,
      )}
    >
      <div className="px-5 pb-4 pt-[18px]">
        <Eyebrow>Your collective power</Eyebrow>
        <div className="mt-2 flex items-baseline gap-2">
          <span
            className="font-display text-[34px] font-bold leading-none tabular-nums"
            style={{ color: isActive ? "var(--algo-blue)" : undefined }}
          >
            {totalVotingPower.toLocaleString()}
          </span>
          <span className="text-[13px] text-muted-foreground">votes</span>
        </div>
        <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">
          Across {eligibleAccounts} eligible account{plural(eligibleAccounts)} you can act for
          {delegatedCount > 0 ? `, including ${delegatedCount} delegated to you` : ""}.
        </p>
      </div>
      <div className={cn("flex items-center gap-[9px] border-t border-border px-5 py-[11px]", strip.bg)}>
        <span className={cn("size-2 shrink-0 rounded-full", strip.dot)} />
        <span className={cn("text-[12.5px] font-semibold", strip.text)}>{strip.label}</span>
      </div>
    </div>
  );
}
