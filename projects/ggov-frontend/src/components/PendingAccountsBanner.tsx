import { Check } from "lucide-react";
import { Avatar, avatarTone } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAddressName } from "@/hooks/use-nfd";
import { ellipseAddress } from "@/utils/ellipseAddress";
import { cn } from "@/lib/utils";

export interface PendingAccount {
  address: string;
  votingPower: number;
  /** Whether this account reached the wallet via delegation. */
  delegated: boolean;
}

interface PendingAccountsBannerProps {
  /** Accounts the wallet controls that are eligible and haven't voted yet. */
  pending: PendingAccount[];
  /** The account that just voted (anchors the "Done" row). */
  votedAccount: { address: string; votingPower: number };
  /** Total accounts the wallet can act for (the `n` in "k of n"). */
  totalAccounts: number;
  /** Switch the active voter to `address` and scroll to the ballot. */
  onSwitchAndVote: (address: string) => void;
  className?: string;
}

/** Resolved NFD name, falling back to the ellipsed address. */
function NameText({ address }: { address: string }) {
  const { data: name } = useAddressName(address);
  return <>{name ?? ellipseAddress(address, 6)}</>;
}

/**
 * Post-vote multi-account nudge (account-checklist variant). After a voter casts
 * with one account, this lists the other accounts they control that are eligible
 * and still need to vote — each with a "Switch & vote" action — plus the account
 * they already voted with marked done.
 */
export default function PendingAccountsBanner({
  pending,
  votedAccount,
  totalAccounts,
  onSwitchAndVote,
  className,
}: PendingAccountsBannerProps) {
  const votedCount = totalAccounts - pending.length;
  return (
    <div
      className={cn(
        "max-w-[560px] overflow-hidden rounded-xl border border-border border-t-[3px] border-t-warning-strong bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-[18px] pb-[13px] pt-[15px]">
        <div className="flex items-center gap-2.5">
          <span className="size-[9px] shrink-0 rounded-full bg-warning-strong" />
          <span className="font-display text-[15px] font-bold">
            {pending.length} of {totalAccounts} accounts still need to vote
          </span>
        </div>
        <span className="shrink-0 text-[12px] text-muted-foreground">{votedCount} voted</span>
      </div>

      {pending.map((account) => (
        <PendingRow key={account.address} account={account} onSwitchAndVote={onSwitchAndVote} />
      ))}

      <div className="flex items-center gap-3 border-t border-border bg-muted/50 px-[18px] py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success/[0.16] text-success-strong">
          <Check className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-muted-foreground">
            <NameText address={votedAccount.address} />
          </div>
          <div className="text-[12.5px] text-muted-foreground">
            Voted · <span className="tabular-nums">{votedAccount.votingPower.toLocaleString()}</span> votes
          </div>
        </div>
        <span className="shrink-0 text-[12px] font-semibold text-success-strong">Done</span>
      </div>
    </div>
  );
}

function PendingRow({
  account,
  onSwitchAndVote,
}: {
  account: PendingAccount;
  onSwitchAndVote: (address: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-[18px] py-3">
      <Avatar name={account.address} tone={avatarTone(account.address)} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-foreground">
            <NameText address={account.address} />
          </span>
          {account.delegated && (
            <span className="shrink-0 rounded-full bg-muted/50 px-[7px] py-[2px] text-[11px] text-muted-foreground">
              delegated to you
            </span>
          )}
        </div>
        <div className="text-[12.5px] text-muted-foreground">
          <strong className="text-foreground tabular-nums">{account.votingPower.toLocaleString()}</strong> votes · eligible
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="w-[118px] shrink-0"
        onClick={() => onSwitchAndVote(account.address)}
      >
        Switch &amp; vote
      </Button>
    </div>
  );
}
