import { AccountAvatar } from "@/components/AccountAvatar";
import { useAddressName } from "@/hooks/use-nfd";
import { ellipseAddress } from "@/utils/ellipseAddress";
import { cn } from "@/lib/utils";

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
  className?: string;
}

type Status = "voted" | "eligible" | "ineligible";

// Mirrors the dot/label language of AccountSelector's STATUS_META so the two
// eligibility views read consistently.
const STATUS_META: Record<Status, { dot: string; label: string; textClass: string }> = {
  voted: { dot: "bg-primary dark:bg-algo-teal", label: "Voted", textClass: "text-primary dark:text-algo-teal" },
  eligible: { dot: "bg-success", label: "Eligible", textClass: "text-success" },
  ineligible: { dot: "bg-muted-foreground", label: "Not eligible", textClass: "text-muted-foreground" },
};

function statusOf(item: WalletEligibilityItem): Status {
  if (!item.eligible) return "ineligible";
  return item.voted ? "voted" : "eligible";
}

/** Two-line identity: NFD name (or ellipsed address) over the mono address. */
function Identity({ address }: { address: string }) {
  const { data: name } = useAddressName(address);
  const ellipsed = ellipseAddress(address, 6);
  const primary = name ?? ellipsed;
  return (
    <div className="min-w-0">
      <span className="truncate text-[14px] font-medium text-foreground">{primary}</span>
      {name && <div className="truncate font-mono text-[12px] text-muted-foreground">{ellipsed}</div>}
    </div>
  );
}

/**
 * Read-only, expandable summary of every connected wallet's eligibility in a
 * period. The `m of n` count stays visible; expanding reveals each wallet's
 * avatar, status, voting power and whether it voted.
 */
export default function ConnectedWalletsEligibility({
  items,
  eligibleCount,
  className,
}: ConnectedWalletsEligibilityProps) {
  const plural = (n: number) => (n !== 1 ? "s" : "");
  const anyEligible = eligibleCount > 0;
  return (
    <details className={cn("group mx-auto max-w-2xl overflow-hidden rounded-xl border border-border bg-card", className)}>
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-[18px] py-[14px] hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2.5">
          <span className={cn("size-[9px] shrink-0 rounded-full", anyEligible ? "bg-success" : "bg-muted-foreground")} />
          <span className="font-display text-[15px] font-bold text-foreground">
            {eligibleCount} of {items.length} connected wallet{plural(items.length)} eligible
          </span>
        </div>
        <span className="shrink-0 text-[13px] font-semibold text-primary dark:text-algo-teal">
          <span className="group-open:hidden">Show details</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="flex flex-col">
        {items.map((item) => {
          const meta = STATUS_META[statusOf(item)];
          return (
            <div key={item.address} className="flex items-center gap-3 border-t border-border px-[18px] py-3">
              <AccountAvatar address={item.address} size={30} />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Identity address={item.address} />
                {item.delegated && (
                  <span className="shrink-0 rounded-full bg-muted/50 px-[7px] py-[2px] text-[11px] text-muted-foreground">
                    delegated
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-[3px]">
                <span className={cn("inline-flex items-center gap-1.5 text-[12px]", meta.textClass)}>
                  <span className={cn("size-[7px] rounded-full", meta.dot)} />
                  {meta.label}
                </span>
                <span className="text-[12.5px] text-muted-foreground">
                  <strong className="text-foreground tabular-nums">{item.votingPower.toLocaleString()}</strong> votes
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
