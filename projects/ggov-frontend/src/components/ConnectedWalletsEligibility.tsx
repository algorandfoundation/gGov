import { ChevronDown } from "lucide-react";
import Address from "@/components/Address";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import type { PeriodStatus } from "@/utils/time";

export interface WalletEligibilityItem {
  address: string;
  /** Window-independent voting power (registry) for this account in the period. */
  votingPower: number;
  /** Whether the account holds voting power in this period. */
  eligible: boolean;
  /** Whether the account cast a vote in this period. */
  voted: boolean;
  /** Whether this account reached the wallet via delegation (vs. a wallet account). */
  delegated: boolean;
}

interface ConnectedWalletsEligibilityProps {
  items: WalletEligibilityItem[];
  /** How many of the connected wallets are eligible — the `m` in `m of n`. */
  eligibleCount: number;
  /** Drives past- vs present-tense wording ("were eligible" once ended). */
  periodStatus: PeriodStatus;
  className?: string;
}

type Status = "voted" | "eligible" | "ineligible";

// Mirrors the dot/label language of AccountSelector's STATUS_META so the two
// eligibility views read consistently.
const STATUS_META: Record<Status, { dot: string; label: string; labelClass: string }> = {
  voted: { dot: "bg-muted-foreground", label: "Voted", labelClass: "text-muted-foreground" },
  eligible: { dot: "bg-primary", label: "Eligible", labelClass: "text-muted-foreground" },
  ineligible: { dot: "bg-destructive", label: "Not eligible", labelClass: "text-destructive" },
};

function statusOf(item: WalletEligibilityItem): Status {
  if (!item.eligible) return "ineligible";
  return item.voted ? "voted" : "eligible";
}

/**
 * Read-only, expandable summary of every connected wallet's eligibility in a
 * period. The `m of n` count stays visible; expanding reveals each wallet's
 * status, voting power and whether it voted.
 */
export default function ConnectedWalletsEligibility({
  items,
  eligibleCount,
  periodStatus,
  className,
}: ConnectedWalletsEligibilityProps) {
  const plural = (n: number) => (n !== 1 ? "s" : "");
  const eligibleVerb = periodStatus === "ended" ? "were eligible" : "will be eligible";
  return (
    <details className={cn("group mx-auto max-w-2xl rounded-xl border border-border", className)}>
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>
          {eligibleCount} of {items.length} connected wallet{plural(items.length)} {eligibleVerb}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-border px-4 py-3">
        {items.map((item) => {
          const meta = STATUS_META[statusOf(item)];
          return (
            <div key={item.address} className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", meta.dot)} />
                <span className="truncate">
                  <Address address={item.address} width={6} copy={false} tooltip={false} />
                </span>
                {item.delegated && (
                  <Tag tone="neutral" className="shrink-0">
                    Delegated
                  </Tag>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <span className={cn("text-xs uppercase tracking-wider", meta.labelClass)}>{meta.label}</span>
                <span className="font-bold tabular-nums">{item.votingPower} Votes</span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
