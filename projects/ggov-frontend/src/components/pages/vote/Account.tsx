import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useWallet } from "@txnlab/use-wallet-react";
import { toast } from "sonner";
import { ArrowDown, ArrowLeftRight, BookOpen, Copy, Info, Target } from "lucide-react";
import { useGGovSDK } from "@/hooks/useGGovSDK";
import { useCommitteeVotingPowers, useMyVotes, useDelegation, useDelegatedToMe } from "@/hooks/queries";
import { useDelegateMutation, useUndelegateMutation, useRedelegateMutation } from "@/hooks/mutations";
import { useAddressName } from "@/hooks/use-nfd";
import { ellipseAddress } from "@/utils/ellipseAddress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/ui/eyebrow";
import { AccountAvatar } from "@/components/AccountAvatar";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import { TxButtonContent } from "@/components/TxButtonContent";
import { cn } from "@/lib/utils";

const DELEGATION_DOCS_URL = "/docs/delegation";

function copyAddress(address: string) {
  navigator.clipboard.writeText(address).then(
    () => toast.success("Address copied"),
    () => toast.error("Couldn't copy address"),
  );
}

/** Restyled card surface matching the vote/period pages (hairline border + sm shadow). */
function Surface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-card shadow-sm", className)} {...props} />;
}

/** Avatar + resolved name over the mono address, in an inset chip (optionally a link). */
function AccountChip({
  address,
  size = 32,
  to,
  compact,
}: {
  address: string;
  size?: number;
  to?: string;
  compact?: boolean;
}) {
  const { data: name } = useAddressName(address);
  const ellipsed = ellipseAddress(address, 6);
  const inner = (
    <>
      <AccountAvatar address={address} name={name} size={size} />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate font-medium", compact ? "text-[13.5px]" : "text-sm")}>{name ?? ellipsed}</div>
        {name && (
          <div className={cn("truncate font-mono text-muted-foreground", compact ? "text-[11.5px]" : "text-xs")}>
            {ellipsed}
          </div>
        )}
      </div>
    </>
  );
  const cls = cn(
    "flex items-center gap-2.5 rounded-lg border border-border bg-muted/40",
    compact ? "px-3 py-2.5" : "px-3.5 py-3",
  );
  return to ? (
    <Link to={to} className={cn(cls, "transition-colors hover:bg-muted/60")}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** "Read more about delegation" docs deep-link in every delegation card footer. */
function DocsLink() {
  return (
    <div className="mt-4 border-t border-border pt-3.5">
      <Link
        to={DELEGATION_DOCS_URL}
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline dark:text-algo-teal"
      >
        <BookOpen className="size-3.5" />
        Read more about delegation
      </Link>
    </div>
  );
}

/** Blue-accented info note used under the delegate / change forms. */
function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0 text-primary dark:text-algo-teal" />
      <span>{children}</span>
    </div>
  );
}

/** Uppercase tracked field label. */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{children}</label>
  );
}

/** Dashed empty-state panel. */
function EmptyPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-4 py-7 text-center text-[13px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

const ORANGE_BTN =
  "text-[#C24A1E] hover:bg-algo-orange/10 disabled:opacity-50 dark:text-algo-orange";

/** Status pill on the delegation card header. */
function DelegationBadge({ delegating }: { delegating: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        delegating ? "bg-primary/10 text-primary dark:text-algo-teal" : "bg-muted text-muted-foreground",
      )}
    >
      {delegating ? "Delegating" : "Self-voting"}
    </span>
  );
}

/**
 * The page's editable core. On your own account it's a delegate / change / remove
 * state machine; on another account (or logged out) it's a read-only status. Reset
 * its sub-state by keying it on the viewed address from the parent.
 */
function DelegationCard({
  isOwnAccount,
  loading,
  delegation,
  ownerName,
  ownerAddress,
  delegateMutation,
  undelegateMutation,
  sdk,
}: {
  isOwnAccount: boolean;
  loading: boolean;
  delegation: { delegatee: string; exists: boolean } | undefined;
  ownerName: string | null | undefined;
  ownerAddress: string;
  delegateMutation: ReturnType<typeof useDelegateMutation>;
  undelegateMutation: ReturnType<typeof useUndelegateMutation>;
  sdk: ReturnType<typeof useGGovSDK>["sdk"];
}) {
  const [mode, setMode] = useState<"view" | "form" | "change">("view");
  const [input, setInput] = useState("");
  const exists = !!delegation?.exists;
  const submitting = delegateMutation.isPending || undelegateMutation.isPending;
  const ownerLabel = ownerName ?? ellipseAddress(ownerAddress, 6);

  function submitDelegate() {
    delegateMutation.mutate(input, {
      onSuccess: () => {
        setMode("view");
        setInput("");
      },
    });
  }

  let body: ReactNode;
  if (loading) {
    body = <Skeleton className="mt-3.5 h-16" />;
  } else if (!isOwnAccount) {
    // Read-only public profile.
    body = exists ? (
      <div className="mt-3.5">
        <p className="mb-2.5 text-[13px] text-muted-foreground">Delegates its voting power to:</p>
        <AccountChip address={delegation!.delegatee} to={`/account/${delegation!.delegatee}`} />
      </div>
    ) : (
      <div className="mt-3.5 flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3.5 py-3">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
          <Target className="size-[17px]" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">Votes for itself</div>
          <div className="text-[12.5px] text-muted-foreground">No delegation — this account votes directly.</div>
        </div>
      </div>
    );
  } else if (exists && mode === "change") {
    body = (
      <div className="mt-3.5">
        <p className="mb-3 text-[13px] text-muted-foreground">Move this account's voting power to a different address.</p>
        <div className="mb-1.5">
          <FieldLabel>Currently delegated to</FieldLabel>
        </div>
        <AccountChip address={delegation!.delegatee} size={28} compact />
        <div className="my-2 flex justify-center text-muted-foreground">
          <ArrowDown className="size-[18px]" />
        </div>
        <FieldLabel>New delegate address</FieldLabel>
        <Input
          className="mt-1.5 font-mono"
          placeholder="GOV…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <InfoNote>
          Changing delegation takes effect immediately. It won't alter votes already cast for the current period.
        </InfoNote>
        <div className="mt-3.5 flex gap-2.5">
          <Button onClick={submitDelegate} disabled={submitting || !input || !sdk} aria-busy={delegateMutation.isPending}>
            <TxButtonContent
              pending={delegateMutation.isPending}
              success={delegateMutation.isSuccess}
              idleLabel="Update delegation"
              pendingLabel="Updating…"
              confirmedLabel="Updated"
            />
          </Button>
          <Button variant="ghost" onClick={() => setMode("view")} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    );
  } else if (exists) {
    body = (
      <div className="mt-3.5">
        <p className="mb-2.5 text-[13px] text-muted-foreground">This account delegates its voting power to:</p>
        <AccountChip address={delegation!.delegatee} />
        <div className="mt-3.5 flex gap-2.5">
          <button
            type="button"
            onClick={() => {
              setMode("change");
              setInput("");
            }}
            disabled={submitting}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-primary bg-background px-3 py-2.5 text-[13.5px] font-semibold text-primary transition-colors hover:bg-primary/5 disabled:opacity-50"
          >
            <ArrowLeftRight className="size-3.5" />
            Change
          </button>
          <button
            type="button"
            onClick={() => undelegateMutation.mutate()}
            disabled={submitting}
            aria-busy={undelegateMutation.isPending}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md border border-algo-orange/40 bg-algo-orange/[0.06] px-3 py-2.5 text-[13.5px] font-semibold transition-colors",
              ORANGE_BTN,
            )}
          >
            <TxButtonContent
              pending={undelegateMutation.isPending}
              success={undelegateMutation.isSuccess}
              idleLabel="Remove"
              pendingLabel="Removing…"
              confirmedLabel="Removed"
            />
          </button>
        </div>
      </div>
    );
  } else if (mode === "form") {
    body = (
      <div className="mt-3.5">
        <p className="mb-2 text-[13px] text-muted-foreground">Delegate this account's voting power to another address.</p>
        <FieldLabel>Delegate to address</FieldLabel>
        <Input
          className="mt-1.5 font-mono"
          placeholder="GOV…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <InfoNote>
          The delegate can vote with this account's power until you remove or change it. You can revoke at any time.
        </InfoNote>
        <div className="mt-3.5 flex gap-2.5">
          <Button onClick={submitDelegate} disabled={submitting || !input || !sdk} aria-busy={delegateMutation.isPending}>
            <TxButtonContent
              pending={delegateMutation.isPending}
              success={delegateMutation.isSuccess}
              idleLabel="Delegate"
              pendingLabel="Delegating…"
              confirmedLabel="Delegated"
            />
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setMode("view");
              setInput("");
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="mt-3.5">
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          No active delegation — <strong className="text-foreground">{ownerLabel}</strong> votes for itself. Delegate to
          let another account vote with this power.
        </p>
        <div className="mt-3.5">
          <Button onClick={() => setMode("form")}>Delegate</Button>
        </div>
      </div>
    );
  }

  return (
    <Surface className="p-5">
      <div className="flex items-center justify-between gap-2.5">
        <Eyebrow>Delegation</Eyebrow>
        {!loading && <DelegationBadge delegating={exists} />}
      </div>
      {body}
      <DocsLink />
    </Surface>
  );
}

/**
 * One row of the "Delegated to You" list. As the delegatee, the active wallet may redirect this
 * incoming delegation onward to a third address (the contract lets a current delegatee re-set the
 * delegator's voting account). Submitting moves the delegator off this list onto the new delegatee.
 */
function DelegatorRow({
  delegator,
  redelegateMutation,
}: {
  delegator: string;
  redelegateMutation: ReturnType<typeof useRedelegateMutation>;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const { data: name } = useAddressName(delegator);
  const ellipsed = ellipseAddress(delegator, 6);
  const active = redelegateMutation.isPending && redelegateMutation.variables?.account === delegator;
  // Distinguish redirecting onward from undoing: undoing points the delegator's voting account back
  // at itself, so its votingAddress equals the delegator.
  const removing = active && redelegateMutation.variables?.votingAddress === delegator;
  const pending = active && !removing;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <AccountAvatar address={delegator} name={name} size={32} />
        <Link to={`/account/${delegator}`} className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium hover:underline">{name ?? ellipsed}</div>
          {name && <div className="truncate font-mono text-xs text-muted-foreground">{ellipsed}</div>}
        </Link>
      </div>
      <div className="flex border-t border-border text-[12.5px] font-semibold">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={removing}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-border py-2.5 text-primary transition-colors hover:bg-muted/50 disabled:opacity-50 dark:text-algo-teal"
        >
          {open ? "Close" : "Re-delegate"}
        </button>
        <button
          type="button"
          disabled={active}
          aria-busy={removing}
          onClick={() => redelegateMutation.mutate({ account: delegator, votingAddress: delegator })}
          className={cn("flex flex-1 items-center justify-center gap-1.5 py-2.5 transition-colors", ORANGE_BTN)}
        >
          <TxButtonContent pending={removing} idleLabel="Remove delegation" pendingLabel="Removing…" />
        </button>
      </div>
      {open && (
        <div className="border-t border-border bg-muted/40 px-3.5 py-3">
          <label className="text-xs font-semibold">Forward {name ?? "this account"}'s delegation to</label>
          <div className="mt-1.5 flex gap-2">
            <Input
              name={`redelegate-${delegator}`}
              className="font-mono text-[12.5px]"
              placeholder="GOV…"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!target || active}
              aria-busy={pending}
              onClick={() =>
                redelegateMutation.mutate(
                  { account: delegator, votingAddress: target },
                  {
                    onSuccess: () => {
                      setTarget("");
                      setOpen(false);
                    },
                  },
                )
              }
            >
              <TxButtonContent pending={pending} idleLabel="Forward" pendingLabel="Redirecting…" />
            </Button>
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            Redirects this incoming delegation to a third address. {name ?? "This account"} keeps delegating, just to
            someone else.
          </p>
        </div>
      )}
    </div>
  );
}

/** Read-only delegator row on another account's profile: a plain linked address. */
function DelegatorLink({ address }: { address: string }) {
  const { data: name } = useAddressName(address);
  const ellipsed = ellipseAddress(address, 6);
  return (
    <Link to={`/account/${address}`} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
      <AccountAvatar address={address} name={name} size={30} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-primary hover:underline dark:text-algo-teal">
          {name ?? ellipsed}
        </div>
        {name && <div className="truncate font-mono text-xs text-muted-foreground">{ellipsed}</div>}
      </div>
    </Link>
  );
}

/** Page heading identity line: own account shows the full address + "This is you"; another shows avatar + name. */
function HeadingIdentity({ address, isOwnAccount }: { address: string; isOwnAccount: boolean }) {
  const { data: name } = useAddressName(address);
  if (isOwnAccount) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-[13px] text-muted-foreground">{address}</span>
        <button
          type="button"
          aria-label="Copy address"
          onClick={() => copyAddress(address)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </button>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary dark:text-algo-teal">
          This is you
        </span>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2.5">
      <AccountAvatar address={address} name={name} size={28} />
      {name && <span className="text-[15px] font-semibold">{name}</span>}
      <span className="break-all font-mono text-[13px] text-muted-foreground">{ellipseAddress(address, 8)}</span>
      <button
        type="button"
        aria-label="Copy address"
        onClick={() => copyAddress(address)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

export default function Account() {
  const { address } = useParams<{ address: string }>();
  const { activeAddress, activeWalletAccounts } = useWallet();
  const navigate = useNavigate();
  const { sdk } = useGGovSDK();
  const isOwnAccount = !!address && !!activeAddress && address === activeAddress;
  const hasMultipleAccounts = (activeWalletAccounts ?? []).length > 1;
  const { data: ownerName } = useAddressName(address ?? "");

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
  const { data: delegation, isLoading: loadingDelegation } = useDelegation(address);
  const { data: delegators = [], isLoading: loadingDelegators } = useDelegatedToMe(address);
  const delegateMutation = useDelegateMutation();
  const undelegateMutation = useUndelegateMutation();
  const redelegateMutation = useRedelegateMutation();

  // The editable delegation card is only useful to accounts that actually hold voting power in some
  // committee (delegating zero power is pointless) or that have received delegations. Other accounts'
  // delegation is shown read-only as account status.
  const canSelfDelegate = committees.length > 0 || delegators.length > 0;
  const showDelegationCard = isOwnAccount ? canSelfDelegate : true;
  const switchName = useAddressName(activeAddress ?? "").data;

  if (!address) {
    return (
      <div className="space-y-3">
        <h1 className="font-display text-3xl font-bold">Account</h1>
        <p className="text-muted-foreground">No account address provided.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1040px]">
      {showSwitchBanner && activeAddress && (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-primary/30 border-l-[3px] border-l-primary bg-primary/[0.07] p-3.5 sm:flex-row sm:items-center">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-background text-primary dark:text-algo-teal">
            <ArrowLeftRight className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">You switched wallet accounts</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              You're now connected as{" "}
              <strong className="text-foreground">{switchName ?? ellipseAddress(activeAddress, 6)}</strong>. Go to its
              account page?
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              onClick={() => {
                setShowSwitchBanner(false);
                navigate(`/account/${activeAddress}`);
              }}
            >
              Switch to my account
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowSwitchBanner(false)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <h1 className="font-display text-3xl font-bold leading-none">Account</h1>
      <HeadingIdentity address={address} isOwnAccount={isOwnAccount} />

      <div className="mt-6 grid grid-cols-1 items-start gap-[18px] lg:grid-cols-2">
        {/* LEFT COLUMN */}
        <div className="flex flex-col gap-[18px]">
          {showDelegationCard && (
            <DelegationCard
              key={address}
              isOwnAccount={isOwnAccount}
              loading={loadingDelegation}
              delegation={delegation}
              ownerName={ownerName}
              ownerAddress={address}
              delegateMutation={delegateMutation}
              undelegateMutation={undelegateMutation}
              sdk={sdk}
            />
          )}

          <Surface className="p-5">
            <div className="flex items-center justify-between gap-2.5">
              <Eyebrow>{isOwnAccount ? "Delegated to you" : "Delegators"}</Eyebrow>
              <span className="shrink-0 text-xs text-muted-foreground">
                {delegators.length === 0
                  ? "No delegators"
                  : `${delegators.length} account${delegators.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {isOwnAccount && delegators.length > 0 && (
              <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">
                You can vote on behalf of these accounts. Their power is added to yours.
              </p>
            )}
            {loadingDelegators ? (
              <Skeleton className="mt-3.5 h-12" />
            ) : delegators.length === 0 ? (
              <EmptyPanel className="mt-3">No accounts have delegated to this address.</EmptyPanel>
            ) : isOwnAccount ? (
              <div className="mt-3.5 flex flex-col gap-2.5">
                {delegators.map((addr) => (
                  <DelegatorRow key={addr} delegator={addr} redelegateMutation={redelegateMutation} />
                ))}
              </div>
            ) : (
              <div className="mt-2.5 flex flex-col">
                {delegators.map((addr) => (
                  <DelegatorLink key={addr} address={addr} />
                ))}
              </div>
            )}
          </Surface>
        </div>

        {/* RIGHT COLUMN */}
        <div className="flex flex-col gap-[18px]">
          <Surface className="overflow-hidden">
            <div className="p-5 pb-3.5">
              <Eyebrow>Voting power by committee</Eyebrow>
              <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">
                Blocks this account produced in each period's committee window. One block, one vote.
              </p>
            </div>
            {loadingCommittees ? (
              <div className="space-y-2 px-5 pb-5">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : committees.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyPanel>No committees found.</EmptyPanel>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_auto] border-b border-border px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  <span>Committee</span>
                  <span className="text-right">Voting power</span>
                </div>
                {committees.map((c) => (
                  <Link
                    key={c.idBase64Url}
                    to={`/committees/${c.idBase64Url}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-2.5 border-b border-border px-5 py-3 transition-colors hover:bg-muted/40"
                  >
                    <span className="truncate font-mono text-[13px] font-medium text-primary dark:text-algo-teal">
                      {c.periodStart.toLocaleString()}–{c.periodEnd.toLocaleString()}
                    </span>
                    <span className="text-right text-sm font-semibold tabular-nums">
                      {c.votingPower.toLocaleString()}
                    </span>
                  </Link>
                ))}
              </>
            )}
          </Surface>
        </div>
      </div>

      {/* VOTES CAST (full width) */}
      <div className="mt-7">
        <div className="mb-3.5 flex items-baseline justify-start gap-3">
          <Eyebrow>Votes cast</Eyebrow>
        </div>
        {loadingVotes ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : votes.length === 0 ? (
          <EmptyPanel className="py-10">No votes cast yet.</EmptyPanel>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {votes.map(({ periodId, period, record, body, topicBodies }) => (
              <Surface key={periodId} className="flex flex-col overflow-hidden">
                <div className="border-b border-border p-4">
                  <div className="flex items-start justify-between gap-2.5">
                    <Link
                      to={`/vote/period/${periodId}`}
                      className="font-display text-[15px] font-bold leading-tight hover:text-primary dark:hover:text-algo-teal"
                    >
                      {body?.title ?? `Period #${periodId}`}
                    </Link>
                    <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
                  </div>
                  {record.isDelegated && (
                    <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">
                      ↪ Voted by a delegate
                    </span>
                  )}
                </div>
                <div className="px-4 pb-3.5 pt-1">
                  {record.topicVotes.map((topicVoteCounts, ti) => {
                    const options = period.topics[ti]?.[0] ?? [];
                    const total = topicVoteCounts.reduce((a, b) => a + b, 0);
                    const nonZero = topicVoteCounts
                      .map((v, oi) => ({ label: options[oi] ?? `Option ${oi + 1}`, votes: v }))
                      .filter((entry) => entry.votes > 0);
                    if (nonZero.length === 0) return null;
                    const single = nonZero.length === 1;
                    const pct = total > 0 ? ((nonZero[0].votes / total) * 100).toFixed(1) : "0.0";
                    return (
                      <div key={ti} className="border-b border-border py-2.5 last:border-0">
                        <div className="mb-1 text-[11px] text-muted-foreground">
                          {topicBodies[ti]?.title ?? `Topic ${ti + 1}`}
                        </div>
                        <div className="flex items-center justify-between gap-2.5">
                          <span className="text-[13.5px] font-semibold">{nonZero.map((e) => e.label).join(", ")}</span>
                          <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                            {single ? `${nonZero[0].votes.toLocaleString()} · ${pct}%` : `${total.toLocaleString()} votes`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Surface>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
