import { Fragment, useRef, type KeyboardEvent } from "react";
import Address from "@/components/Address";
import { cn } from "@/lib/utils";

export interface AccountSelectorItem {
  address: string;
  /** Display label instead of the address (e.g. "You"). */
  label?: string;
  /** Voting power for this period; `undefined` while loading. */
  votingPower?: bigint;
  /** Whether this account is eligible to vote; `undefined` while loading. */
  canVote?: boolean;
  /** Whether this account has already voted; `undefined` while loading. */
  hasVoted?: boolean;
  /**
   * Whether this account cast its own vote directly. A delegate cannot override
   * a direct vote, so a delegated account in this state is locked.
   */
  votedDirectly?: boolean;
  /** Accounts that have delegated their voting power to this account. */
  delegated?: AccountSelectorItem[];
}

interface AccountSelectorProps {
  accounts: AccountSelectorItem[];
  selected: string | null;
  onSelect: (address: string) => void;
  className?: string;
}

type Status = "eligible" | "voted" | "ineligible" | "loading" | "locked";

function statusOf(item: AccountSelectorItem, delegated?: boolean): Status {
  // A delegator that voted for itself directly cannot be overridden by its delegate.
  if (delegated && item.votedDirectly) return "locked";
  if (item.canVote === undefined) return "loading";
  if (!item.canVote || (item.votingPower ?? 0n) <= 0n) return "ineligible";
  if (item.hasVoted) return "voted";
  return "eligible";
}

const STATUS_META: Record<Status, { dot: string; label: string; right: string; rightClass: string }> = {
  eligible: { dot: "bg-primary", label: "Eligible", right: "Eligible", rightClass: "text-muted-foreground" },
  voted: { dot: "bg-muted-foreground", label: "Voted", right: "Completed", rightClass: "text-muted-foreground" },
  ineligible: { dot: "bg-destructive", label: "Not eligible", right: "Ineligible", rightClass: "text-destructive" },
  loading: { dot: "bg-muted-foreground/40", label: "Checking…", right: "", rightClass: "text-muted-foreground" },
  locked: {
    dot: "bg-destructive",
    label: "Voted directly · delegate can't override",
    right: "Locked",
    rightClass: "text-destructive",
  },
};

/** Whether a row can be selected (loading/eligible/voted), vs dimmed and skipped by keyboard nav. */
function isDisabled(item: AccountSelectorItem, delegated?: boolean): boolean {
  const status = statusOf(item, delegated);
  return status === "ineligible" || status === "locked";
}

interface RowProps {
  item: AccountSelectorItem;
  selected: string | null;
  onSelect: (address: string) => void;
  /** Rendered as a delegated child of another account. */
  delegated?: boolean;
  /** Roving-tabindex target: only the active radio is in the tab order. */
  tabIndex: number;
  registerRef: (address: string, el: HTMLButtonElement | null) => void;
}

function AccountRow({ item, selected, onSelect, delegated, tabIndex, registerRef }: RowProps) {
  const status = statusOf(item, delegated);
  const meta = STATUS_META[status];
  const isSelected = selected === item.address;
  const disabled = isDisabled(item, delegated);
  const statusLabel = status === "locked" ? meta.label : delegated ? `Delegated · ${meta.label}` : meta.label;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={disabled}
      tabIndex={tabIndex}
      ref={(el) => registerRef(item.address, el)}
      onClick={() => onSelect(item.address)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition-all",
        isSelected
          ? "border-2 border-primary bg-primary/5"
          : "border-border hover:bg-muted/50 hover:border-foreground/20",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent hover:border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
            isSelected ? "border-primary" : "border-muted-foreground/40",
          )}
        >
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full bg-primary transition-opacity",
              isSelected ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {item.label ?? <Address address={item.address} width={8} copy={false} tooltip={false} />}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
            <span className="text-xs text-muted-foreground">Status: {statusLabel}</span>
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn("font-bold tabular-nums", isSelected ? "text-primary" : "text-foreground")}>
          {item.votingPower === undefined ? "—" : `${item.votingPower.toString()} Votes`}
        </p>
        {meta.right && <p className={cn("text-xs uppercase tracking-wider", meta.rightClass)}>{meta.right}</p>}
      </div>
    </button>
  );
}

/**
 * Stitch-style account selection: each connected/delegated account is a radio
 * card showing its status and voting power. Accounts that delegated their power
 * to one of your accounts are nested beneath that delegatee, indented with a
 * "↪" branch. Ineligible accounts are dimmed and not selectable.
 */
export default function AccountSelector({ accounts, selected, onSelect, className }: AccountSelectorProps) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRef = (address: string, el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(address, el);
    else buttonRefs.current.delete(address);
  };

  // Selectable addresses in render order (top-level rows interleaved with their
  // delegated children), used to drive arrow-key navigation and roving tabindex.
  const enabledAddrs = accounts.flatMap((item) => [
    ...(isDisabled(item) ? [] : [item.address]),
    ...(item.delegated ?? []).filter((c) => !isDisabled(c, true)).map((c) => c.address),
  ]);
  // Only one radio sits in the tab order: the selected one, else the first eligible.
  const tabbable = selected && enabledAddrs.includes(selected) ? selected : enabledAddrs[0];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    if (enabledAddrs.length === 0) return;
    e.preventDefault();
    const current = selected && enabledAddrs.includes(selected) ? enabledAddrs.indexOf(selected) : 0;
    const last = enabledAddrs.length - 1;
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? last
      : e.key === "ArrowDown" || e.key === "ArrowRight" ? (current + 1) % enabledAddrs.length
      : (current - 1 + enabledAddrs.length) % enabledAddrs.length;
    const addr = enabledAddrs[next];
    onSelect(addr);
    buttonRefs.current.get(addr)?.focus();
  }

  return (
    <div className={cn("space-y-3", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account Selection</h3>
      <div
        className="grid grid-cols-1 gap-2"
        role="radiogroup"
        aria-label="Select account to vote as"
        onKeyDown={onKeyDown}
      >
        {accounts.map((item) => (
          <Fragment key={item.address}>
            <AccountRow
              item={item}
              selected={selected}
              onSelect={onSelect}
              tabIndex={item.address === tabbable ? 0 : -1}
              registerRef={registerRef}
            />
            {item.delegated?.map((child) => (
              <div key={child.address} className="relative pl-8">
                <span
                  className="pointer-events-none absolute left-2 top-4 select-none text-muted-foreground"
                  aria-hidden="true"
                >
                  ↪
                </span>
                <AccountRow
                  item={child}
                  selected={selected}
                  onSelect={onSelect}
                  delegated
                  tabIndex={child.address === tabbable ? 0 : -1}
                  registerRef={registerRef}
                />
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
