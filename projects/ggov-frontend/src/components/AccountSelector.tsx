import { Fragment, useRef, type KeyboardEvent } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { useAddressName } from "@/hooks/use-nfd";
import { ellipseAddress } from "@/utils/ellipseAddress";
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
  /** Count of the wallet's own accounts (for the "N connected accounts" subline). */
  connectedCount?: number;
  /** Count of accounts delegated to the wallet (for the subline). */
  delegatedCount?: number;
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

const STATUS_META: Record<Status, { dot: string; label: string; textClass: string }> = {
  eligible: { dot: "bg-success", label: "Eligible", textClass: "text-success" },
  voted: { dot: "bg-primary dark:bg-algo-teal", label: "Voted", textClass: "text-primary dark:text-algo-teal" },
  ineligible: { dot: "bg-muted-foreground", label: "Not eligible", textClass: "text-muted-foreground" },
  loading: { dot: "bg-muted-foreground/40", label: "Checking…", textClass: "text-muted-foreground" },
  locked: {
    dot: "bg-muted-foreground",
    label: "Voted directly · delegate can't override",
    textClass: "text-muted-foreground",
  },
};

/** Whether a row can be selected (loading/eligible/voted), vs dimmed and skipped by keyboard nav. */
function isDisabled(item: AccountSelectorItem, delegated?: boolean): boolean {
  const status = statusOf(item, delegated);
  return status === "ineligible" || status === "locked";
}

/** Accounts with no voting power for this period are hidden from the list entirely. */
function isHidden(item: AccountSelectorItem, delegated?: boolean): boolean {
  return statusOf(item, delegated) === "ineligible";
}

/** Two-line identity: NFD name (or ellipsed address) over the mono address. */
function Identity({ item }: { item: AccountSelectorItem }) {
  const { data: name } = useAddressName(item.address);
  const ellipsed = ellipseAddress(item.address, 6);
  const primary = item.label ?? name ?? ellipsed;
  // Only show the mono address line when the primary line is a resolved name/label.
  const showAddress = primary !== ellipsed;
  return (
    <div className="min-w-0">
      <span className="truncate text-[14px] font-medium text-foreground">{primary}</span>
      {showAddress && <div className="truncate font-mono text-[12px] text-muted-foreground">{ellipsed}</div>}
    </div>
  );
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
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition-all",
        isSelected
          ? "border-2 border-primary bg-primary/5"
          : "border-border hover:bg-muted/50 hover:border-foreground/20",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent hover:border-border",
      )}
    >
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
      <AccountAvatar address={item.address} name={item.label} size={30} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Identity item={item} />
        {delegated && (
          <span className="shrink-0 rounded-full bg-muted/50 px-[7px] py-[2px] text-[11px] text-muted-foreground">
            delegated to you
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[3px]">
        <span className={cn("inline-flex items-center gap-1.5 text-[12px]", meta.textClass)}>
          <span
            className={cn(
              "size-[7px] rounded-full",
              meta.dot,
              status === "eligible" && "motion-safe:animate-bounce motion-safe:[animation-duration:0.5s]",
            )}
          />
          {meta.label}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          {item.votingPower === undefined ? (
            "—"
          ) : (
            <>
              <strong className="text-foreground tabular-nums">{item.votingPower.toString()}</strong> votes
            </>
          )}
        </span>
      </div>
    </button>
  );
}

/**
 * Account selection: each connected/delegated account is a radio card showing an
 * avatar, identity, status and voting power. Accounts that delegated their power
 * to one of your accounts are nested beneath that delegatee, indented with a "↪"
 * branch. Ineligible accounts (no voting power this period) are hidden; a locked
 * account (voted directly, delegate can't override) is shown dimmed.
 */
export default function AccountSelector({
  accounts,
  selected,
  onSelect,
  connectedCount,
  delegatedCount,
  className,
}: AccountSelectorProps) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRef = (address: string, el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(address, el);
    else buttonRefs.current.delete(address);
  };

  // Drop ineligible accounts from the list. Ineligible delegated children are
  // pruned from each parent; an ineligible parent is kept only when it still has
  // visible children, since it remains the nesting header for those delegators.
  const visibleAccounts = accounts
    .map((item) => ({
      ...item,
      delegated: (item.delegated ?? []).filter((c) => !isHidden(c, true)),
    }))
    .filter((item) => !isHidden(item) || item.delegated.length > 0);

  // Selectable addresses in render order (top-level rows interleaved with their
  // delegated children), used to drive arrow-key navigation and roving tabindex.
  const enabledAddrs = visibleAccounts.flatMap((item) => [
    ...(isDisabled(item) ? [] : [item.address]),
    ...item.delegated.filter((c) => !isDisabled(c, true)).map((c) => c.address),
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
    <div className={cn("space-y-3.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-[15px] font-bold">Voting as</h3>
        {connectedCount != null && (
          <span className="text-xs text-muted-foreground">
            {connectedCount} connected account{connectedCount === 1 ? "" : "s"}
            {delegatedCount ? ` · ${delegatedCount} delegated to you` : ""}
          </span>
        )}
      </div>
      <div
        className="grid grid-cols-1 gap-2"
        role="radiogroup"
        aria-label="Select account to vote as"
        onKeyDown={onKeyDown}
      >
        {visibleAccounts.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
            None of your accounts have voting power this period.
          </p>
        )}
        {visibleAccounts.map((item) => (
          <Fragment key={item.address}>
            <AccountRow
              item={item}
              selected={selected}
              onSelect={onSelect}
              tabIndex={item.address === tabbable ? 0 : -1}
              registerRef={registerRef}
            />
            {item.delegated.map((child) => (
              <div key={child.address} className="relative pl-8">
                <span
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 select-none text-muted-foreground"
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
