import { Fragment, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Droplets } from 'lucide-react'
import { AccountAvatar } from '@/components/AccountAvatar'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { formatApprox } from '@/utils/format'
import { cn } from '@/lib/utils'

export interface AccountSelectorItem {
  address: string
  /** Display label instead of the address (e.g. "You"). */
  label?: string
  /** Voting power for this period; `undefined` while loading. */
  votingPower?: bigint
  /** Whether this account is eligible to vote; `undefined` while loading. */
  canVote?: boolean
  /** Whether this account has already voted; `undefined` while loading. */
  hasVoted?: boolean
  /**
   * Whether this account cast its own vote directly. A delegate cannot override
   * a direct vote, so a delegated account in this state is locked.
   */
  votedDirectly?: boolean
  /** Accounts that have delegated their voting power to this account. */
  delegated?: AccountSelectorItem[]
  /**
   * Staking-pool positions this account holds — its prorated share of a pool's
   * gGov power, cast through the pool rather than by the account itself. Nested
   * one level under the account, and one level under *that* for a delegator's
   * pools (so a delegator's pool sits two levels deep).
   */
  pooled?: PooledSelectorItem[]
}

/**
 * A selectable staking-pool position. Not an account: `id` rather than an address,
 * no avatar identicon, and its weight is approximate (the pool's on-chain split
 * rounds, with the last option absorbing the remainder).
 */
export interface PooledSelectorItem {
  /** Selection key — `{instanceNumId}:{owner}`, never a bare address. */
  id: string
  /** The pool's own label, as it reports it. */
  instanceName: string
  /** This position's share of the pool, as a percentage. */
  sharePct: number
  /** Approximate votes the share is worth. */
  votes: number
  /**
   * Set when the position belongs to an account that delegated to you — the owner's
   * address, resolved to a name by the row itself (same as {@link Identity}).
   */
  viaAddress?: string
  canVote?: boolean
  hasVoted?: boolean
  /** The owner cast this pool's vote itself, so a delegate cannot override it. */
  votedDirectly?: boolean
  /** Has stake, but the pool hasn't synced this period or is still ingesting. */
  poolNotReady?: boolean
}

interface AccountSelectorProps {
  accounts: AccountSelectorItem[]
  selected: string | null
  /** Receives an account address, or a pooled position's `id`. */
  onSelect: (id: string) => void
  /** Count of the wallet's own accounts (for the "N connected accounts" subline). */
  connectedCount?: number
  /** Count of accounts delegated to the wallet (for the subline). */
  delegatedCount?: number
  /** Count of selectable pooled positions (for the subline). */
  pooledCount?: number
  className?: string
}

type Status = 'eligible' | 'voted' | 'ineligible' | 'loading' | 'locked' | 'poolNotReady'

function statusOf(item: AccountSelectorItem, delegated?: boolean): Status {
  // A delegator that voted for itself directly cannot be overridden by its delegate.
  if (delegated && item.votedDirectly) return 'locked'
  if (item.canVote === undefined) return 'loading'
  if (!item.canVote || (item.votingPower ?? 0n) <= 0n) return 'ineligible'
  if (item.hasVoted) return 'voted'
  return 'eligible'
}

/**
 * Pooled rows reach the same statuses by a different route: the weight is always
 * non-zero (a zero-AQ position is never built), so ineligibility is either the
 * owner's own vote blocking a delegate, or the pool not being ready.
 */
function pooledStatusOf(item: PooledSelectorItem): Status {
  if (item.viaAddress && item.votedDirectly) return 'locked'
  if (item.canVote === undefined) return 'loading'
  if (item.hasVoted) return 'voted'
  if (item.poolNotReady) return 'poolNotReady'
  if (!item.canVote) return 'ineligible'
  return 'eligible'
}

/**
 * `detail` is the part of a status that only fits on wider viewports — on mobile
 * the row is barely wider than the label itself, and the overflow ran across the
 * identity column.
 */
const STATUS_META: Record<Status, { dot: string; label: string; detail?: string; textClass: string }> = {
  eligible: { dot: 'bg-success', label: 'Eligible', textClass: 'text-success' },
  voted: { dot: 'bg-primary dark:bg-algo-teal', label: 'Voted', textClass: 'text-primary dark:text-algo-teal' },
  ineligible: { dot: 'bg-muted-foreground', label: 'Not eligible', textClass: 'text-muted-foreground' },
  loading: { dot: 'bg-muted-foreground/40', label: 'Checking…', textClass: 'text-muted-foreground' },
  locked: {
    dot: 'bg-muted-foreground',
    label: 'Voted directly',
    detail: " · delegate can't override",
    textClass: 'text-muted-foreground',
  },
  // The member's standing is fine — the pool hasn't snapshotted this period yet,
  // or its AlgoQuarters ledger is still being ingested. Nothing for them to fix.
  poolNotReady: { dot: 'bg-muted-foreground', label: 'Pool not ready', textClass: 'text-muted-foreground' },
}

/** Whether a row can be selected (loading/eligible/voted), vs dimmed and skipped by keyboard nav. */
function isDisabled(item: AccountSelectorItem, delegated?: boolean): boolean {
  const status = statusOf(item, delegated)
  return status === 'ineligible' || status === 'locked'
}

/**
 * Pooled positions are never hidden the way a zero-power account is — the share
 * exists and is worth showing even when it can't be cast right now — but a
 * position that can't be voted is dimmed and skipped by keyboard nav.
 */
function isPooledDisabled(item: PooledSelectorItem): boolean {
  const status = pooledStatusOf(item)
  return status === 'ineligible' || status === 'locked' || status === 'poolNotReady'
}

/**
 * Accounts with no voting power this period are hidden entirely. An account that
 * still has voting power but can't vote (e.g. a delegator who voted directly, so
 * its delegate can't override) is kept — that standing is relevant, shown dimmed.
 */
function isHidden(item: AccountSelectorItem, delegated?: boolean): boolean {
  return statusOf(item, delegated) === 'ineligible' && (item.votingPower ?? 0n) <= 0n
}

/** Two-line identity: NFD name (or ellipsed address) over the mono address. */
function Identity({ item }: { item: AccountSelectorItem }) {
  const { data: name } = useAddressName(item.address)
  const ellipsed = ellipseAddress(item.address, 6)
  const primary = item.label ?? name ?? ellipsed
  // Only show the mono address line when the primary line is a resolved name/label.
  const showAddress = primary !== ellipsed
  return (
    // `max-w-full` matters in the mobile (column) layout: `truncate` sets
    // white-space:nowrap, so this box's min-content width is the whole
    // untruncated line and `items-start` would size it to that — overflowing
    // across the status column instead of ellipsing.
    <div className="min-w-0 max-w-full">
      {/* Block, not inline: `truncate`'s overflow clipping is a no-op on an inline
          box, so a long name ran under the status column instead of ellipsing. */}
      <div className="truncate text-[14px] font-medium text-foreground" title={primary}>
        {primary}
      </div>
      {showAddress && <div className="truncate font-mono text-[12px] text-muted-foreground">{ellipsed}</div>}
    </div>
  )
}

interface RowProps {
  item: AccountSelectorItem
  selected: string | null
  onSelect: (address: string) => void
  /** Rendered as a delegated child of another account. */
  delegated?: boolean
  /** Roving-tabindex target: only the active radio is in the tab order. */
  tabIndex: number
  registerRef: (address: string, el: HTMLButtonElement | null) => void
}

function AccountRow({ item, selected, onSelect, delegated, tabIndex, registerRef }: RowProps) {
  const status = statusOf(item, delegated)
  const meta = STATUS_META[status]
  const isSelected = selected === item.address
  const disabled = isDisabled(item, delegated)
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
        // Keep the border width constant (1px) and only animate colors: selecting a
        // row used to grow the border from 1px to 2px under `transition-all`, which
        // reflowed the box (and its neighbours) and made the selection look laggy.
        'flex w-full cursor-pointer items-center gap-2.5 md:gap-3 rounded-xl border-1 p-3 text-left transition-colors',
        isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50 hover:border-foreground/20',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent hover:border-border',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          isSelected ? 'border-primary' : 'border-muted-foreground/40',
        )}
      >
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full bg-primary transition-opacity',
            isSelected ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
      <AccountAvatar address={item.address} name={item.label} size={30} />
      <div className="flex flex-col md:flex-row min-w-0 flex-1 items-start md:items-center md:gap-2">
        <Identity item={item} />
        {delegated && (
          <span className="shrink-0 rounded-full bg-muted/50 px-[7px] py-[2px] text-[11px] text-muted-foreground">
            delegated to you
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[3px]">
        <span className={cn('inline-flex items-center gap-1.5 text-[12px]', meta.textClass)}>
          <span
            className={cn(
              'size-[7px] rounded-full',
              meta.dot,
              status === 'eligible' && 'motion-safe:animate-bounce motion-safe:[animation-duration:0.5s]',
            )}
          />
          <span className="whitespace-nowrap">
            {meta.label}
            {meta.detail && <span className="hidden md:inline">{meta.detail}</span>}
          </span>
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          {item.votingPower === undefined ? (
            '—'
          ) : (
            <>
              <strong className="text-foreground tabular-nums">{item.votingPower.toString()}</strong> votes
            </>
          )}
        </span>
      </div>
    </button>
  )
}

interface PooledRowProps {
  item: PooledSelectorItem
  selected: string | null
  onSelect: (id: string) => void
  tabIndex: number
  registerRef: (id: string, el: HTMLButtonElement | null) => void
}

/**
 * A staking-pool position, styled to sit alongside {@link AccountRow} but read as
 * a distinct kind of thing: a teal droplet glyph rather than an address identicon
 * (a pool is not an address you could copy), a "pooled" pill, and an approximate
 * weight behind "≈".
 */
function PooledRow({ item, selected, onSelect, tabIndex, registerRef }: PooledRowProps) {
  const meta = STATUS_META[pooledStatusOf(item)]
  const isSelected = selected === item.id
  const disabled = isPooledDisabled(item)
  const viaName = useAddressName(item.viaAddress ?? '').data
  const owner = item.viaAddress ? (viaName ?? ellipseAddress(item.viaAddress, 4)) : undefined
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={disabled}
      tabIndex={tabIndex}
      ref={(el) => registerRef(item.id, el)}
      onClick={() => onSelect(item.id)}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 md:gap-3 rounded-xl border-1 p-3 text-left transition-colors',
        isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50 hover:border-foreground/20',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent hover:border-border',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          isSelected ? 'border-primary' : 'border-muted-foreground/40',
        )}
      >
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full bg-primary transition-opacity',
            isSelected ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-algo-teal/10">
        <Droplets className="size-4 text-teal-strong" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start md:flex-row md:items-center md:gap-2">
        <div className="min-w-0 max-w-full">
          <div className="truncate text-[14px] font-medium text-foreground" title={item.instanceName}>
            {item.instanceName}
          </div>
          {/* Mobile keeps only the number — the row is too narrow for the whose-share
              prefix, and the nesting already says who the position belongs to. */}
          <div className="truncate text-[12px] text-muted-foreground">
            <span className="hidden md:inline">{owner ? `${owner}'s share` : 'Your share'}: </span>
            {item.sharePct.toFixed(2)}% of<span className="hidden md:inline"> the</span> pool
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-algo-teal/10 px-2 py-[2px] text-[11px] font-semibold text-teal-strong">
          pooled
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[3px]">
        <span className={cn('inline-flex items-center gap-1.5 text-[12px]', meta.textClass)}>
          <span className={cn('size-[7px] rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          <strong className="text-foreground tabular-nums">≈ {formatApprox(item.votes)}</strong> votes
        </span>
      </div>
    </button>
  )
}

/**
 * Account selection: each connected/delegated account is a radio card showing an
 * avatar, identity, status and voting power. Accounts that delegated their power
 * to one of your accounts are nested beneath that delegatee, indented with a "↪"
 * branch. Accounts with no voting power this period are hidden; ones that still
 * have voting power but can't vote (locked, or a delegator who voted directly)
 * are shown dimmed.
 *
 * Staking-pool positions nest one level under the account that holds them, so a
 * delegator's pool lands two levels deep. They share the radio group with the
 * accounts — one selection casts one ballot — and are keyed by `id` rather than
 * address, which is why `selected`/`onSelect` deal in ids.
 */
export default function AccountSelector({
  accounts,
  selected,
  onSelect,
  connectedCount,
  delegatedCount,
  pooledCount,
  className,
}: AccountSelectorProps) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const registerRef = (id: string, el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(id, el)
    else buttonRefs.current.delete(id)
  }

  // Drop ineligible accounts from the list. Ineligible delegated children are
  // pruned from each parent; an ineligible parent is kept only when it still has
  // visible children, since it remains the nesting header for those delegators —
  // pooled positions count as children for that purpose too, otherwise a
  // pooled-only account (no blocks produced) would take its own pools down with it.
  const visibleAccounts = accounts
    .map((item) => ({
      ...item,
      delegated: (item.delegated ?? []).filter((c) => !isHidden(c, true) || (c.pooled ?? []).length > 0),
      pooled: item.pooled ?? [],
    }))
    .filter((item) => !isHidden(item) || item.delegated.length > 0 || item.pooled.length > 0)

  // Selectable ids in render order (top-level rows, each followed by its pooled
  // positions, then its delegated children with their own pools), used to drive
  // arrow-key navigation and roving tabindex.
  const enabledIds = visibleAccounts.flatMap((item) => [
    ...(isDisabled(item) ? [] : [item.address]),
    ...item.pooled.filter((p) => !isPooledDisabled(p)).map((p) => p.id),
    ...item.delegated.flatMap((child) => [
      ...(isDisabled(child, true) ? [] : [child.address]),
      ...(child.pooled ?? []).filter((p) => !isPooledDisabled(p)).map((p) => p.id),
    ]),
  ])
  // Only one radio sits in the tab order: the selected one, else the first eligible.
  const tabbable = selected && enabledIds.includes(selected) ? selected : enabledIds[0]

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
    if (enabledIds.length === 0) return
    e.preventDefault()
    const current = selected && enabledIds.includes(selected) ? enabledIds.indexOf(selected) : 0
    const last = enabledIds.length - 1
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : e.key === 'ArrowDown' || e.key === 'ArrowRight'
            ? (current + 1) % enabledIds.length
            : (current - 1 + enabledIds.length) % enabledIds.length
    const id = enabledIds[next]
    onSelect(id)
    buttonRefs.current.get(id)?.focus()
  }

  return (
    <div className={cn('space-y-3.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-[15px] font-bold">Voting as</h3>
        {connectedCount != null && (
          <span className="text-xs text-muted-foreground">
            {connectedCount} connected account{connectedCount === 1 ? '' : 's'}
            {delegatedCount ? ` · ${delegatedCount} delegated to you` : ''}
            {pooledCount ? ` · ${pooledCount} pooled position${pooledCount === 1 ? '' : 's'}` : ''}
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
            {item.pooled.map((position) => (
              <NestedRow key={position.id} depth={1}>
                <PooledRow
                  item={position}
                  selected={selected}
                  onSelect={onSelect}
                  tabIndex={position.id === tabbable ? 0 : -1}
                  registerRef={registerRef}
                />
              </NestedRow>
            ))}
            {item.delegated.map((child) => (
              <Fragment key={child.address}>
                <NestedRow depth={1}>
                  <AccountRow
                    item={child}
                    selected={selected}
                    onSelect={onSelect}
                    delegated
                    tabIndex={child.address === tabbable ? 0 : -1}
                    registerRef={registerRef}
                  />
                </NestedRow>
                {(child.pooled ?? []).map((position) => (
                  <NestedRow key={position.id} depth={2}>
                    <PooledRow
                      item={position}
                      selected={selected}
                      onSelect={onSelect}
                      tabIndex={position.id === tabbable ? 0 : -1}
                      registerRef={registerRef}
                    />
                  </NestedRow>
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** Indented row with the "↪" branch glyph, at one of two nesting depths. */
function NestedRow({ depth, children }: { depth: 1 | 2; children: ReactNode }) {
  return (
    // Indent is tighter on mobile: every pixel here comes straight out of the
    // row's identity column, which is what runs out of room first.
    <div className={cn('relative', depth === 1 ? 'pl-6 md:pl-8' : 'pl-11 md:pl-16')}>
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 select-none text-muted-foreground',
          depth === 1 ? 'left-1 md:left-2' : 'left-6 md:left-10',
        )}
        aria-hidden="true"
      >
        ↪
      </span>
      {children}
    </div>
  )
}
